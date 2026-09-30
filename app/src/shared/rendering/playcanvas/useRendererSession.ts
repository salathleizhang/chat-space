import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { WebGPUDeviceOptions } from "./device";
import type { CreateAppOptions } from "./app";
import { readAdapterIdentity, type AdapterIdentity } from "./device";
import { RendererSession, type SessionSnapshot } from "./session";

/**
 * `RendererSession` 的 React 薄适配。
 *
 * 为什么不用 `@playcanvas/react`（本机核实，0.11.7）：
 *  - 它的 props 是**运行时类型反射**出来的，`camera.layers` / `camera.framePasses` /
 *    `render.meshInstances` 这类结构化句柄**会被静默丢弃**（`validation.ts:278-285` 把数组摊成
 *    对象，导致 `Array.isArray` 分支成为死代码）。而逐窗格 layer 过滤正是本应用分屏的核心机制。
 *  - **无法注入 graphicsDevice**，因此拿不到 WebGPU-only 的保证（见 `device.ts`）。
 *  - 它的清理用 `useLayoutEffect`、而调用方的清理通常用 `useEffect`，于是 `app.destroy()` 会
 *    先于子组件的清理执行，`app.root` 已经是 null。
 *  - 两年仍停在 0.x（0.11.3 → 0.11.4 之间停发 5 个月），而 `playcanvas` 本体每天发 beta。
 *
 * **使用约定（重要）**：需要摘除 3D 资源的子组件请用 `useLayoutEffect` 做清理，不要用 `useEffect`。
 * React 卸载时子组件的 layout effect 清理先于父组件的执行，所以那时引擎仍然活着；
 * 而 passive（`useEffect`）清理排在所有 layout 清理之后，`app` 已经被销毁。
 */

export interface UseRendererSessionOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  device?: WebGPUDeviceOptions;
  app?: CreateAppOptions;
  teardownDelayMs?: number;
}

export interface RendererSessionHandle extends SessionSnapshot {
  /** 适配器身份，仅用于诊断展示（`gpuAdapter` 在 d.ts 里是 private）。 */
  adapter: AdapterIdentity | null;
  /** 出错后重试：立刻释放旧会话并重建。 */
  retry: () => void;
}

const IDLE: SessionSnapshot = { status: "idle", error: null, device: null, app: null, deviceLost: false };

export function useRendererSession({ canvasRef, device, app, teardownDelayMs }: UseRendererSessionOptions): RendererSessionHandle {
  const [attempt, setAttempt] = useState(0);
  // session 放在 ref 里：React 19 的 StrictMode 会"挂载 → 卸载 → 再挂载"同一个组件实例，
  // 而 ref 在这两次之间是保留的。若每次 setup 都新建会话，就会真的建两个设备。
  const held = useRef<{ canvas: HTMLCanvasElement; attempt: number; session: RendererSession } | null>(null);
  const [session, setSession] = useState<RendererSession | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let entry = held.current;
    if (!entry || entry.canvas !== canvas || entry.attempt !== attempt) {
      // 换了画布或用户点了重试：旧会话立刻释放，不等延迟窗口。
      if (entry) void entry.session.dispose();
      entry = { canvas, attempt, session: new RendererSession({ canvas, device, app, teardownDelayMs }) };
      held.current = entry;
    }
    // claim() 会取消"模拟卸载"预约的释放，并在需要时开始建立。
    entry.session.claim();
    setSession(entry.session);
    return () => { entry.session.release(); };
    // device/app 只读一次：它们是建会话时的快照，改它们需要显式重试。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, attempt]);

  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => {}), [session]);
  const getSnapshot = useCallback(() => session?.getSnapshot() ?? IDLE, [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => IDLE);

  const retry = useCallback(() => { setAttempt((value) => value + 1); }, []);

  return { ...snapshot, adapter: snapshot.device ? readAdapterIdentity(snapshot.device) : null, retry };
}
