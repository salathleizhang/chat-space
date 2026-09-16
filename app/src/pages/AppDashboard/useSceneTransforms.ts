import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveSceneTransforms, type AssetTransform } from "../../shared/lib/libraryApi";

/**
 * 共享场景里各资产的摆放：磁盘上的 scene.json（经 projectState 读回）叠加本会话
 * 用视口 gizmo 调过的那部分。没有记录的资产不出现在这里——它们由
 * `Viewport/scenePlacement.ts` 算网格默认位（默认摆位是派生的，不落盘）。
 *
 * 两条纪律：
 * ① **乐观更新**：拖完立刻改本地 state，不等网络往返，落盘防抖 500ms 在后面追。
 * ② **本地覆盖优先于服务端**（`{...remote, ...local}` 的合并顺序）：`refreshKey` 重扫拿回来的
 *    remote 不会顶掉本会话改过的资产，否则"拖完模型顺手导入一个新模型"会因为防抖还没
 *    写完、重扫先回来，把刚摆好的位置弹回旧值。
 */
export function useSceneTransforms(
  projectSlug: string,
  remote: Record<string, AssetTransform>,
  onError?: (message: string) => void,
) {
  // ProjectDashboard 以 projectSlug 为 key；切项目会重挂载，本地账本天然隔离。
  const [local, setLocal] = useState<Record<string, AssetTransform>>({});
  const pendingRef = useRef<{ slug: string; transforms: Record<string, AssetTransform> } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const transforms = useMemo(() => ({ ...remote, ...local }), [remote, local]);

  const commitTransforms = useCallback(
    (updates: Record<string, AssetTransform>) => {
      setLocal((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  /**
   * 资产删除后摘掉它的本地覆盖（服务端那份由 `deleteAsset` 自己清）。不摘的话，
   * 删掉 `chair` 再导入一个同名 `chair`（slug 复用）会继承上一个资产的摆位。
   */
  const dropTransform = useCallback(
    (assetSlug: string) => {
      const pending = pendingRef.current;
      if (pending && assetSlug in pending.transforms) {
        const { [assetSlug]: _dropped, ...rest } = pending.transforms;
        pendingRef.current = Object.keys(rest).length > 0
          ? { ...pending, transforms: rest }
          : null;
      }
      setLocal((prev) => {
        if (!(assetSlug in prev)) return prev;
        const { [assetSlug]: _dropped, ...rest } = prev;
        return rest;
      });
    },
    [],
  );

  /**
   * 同一工作台的保存严格按产生顺序执行。服务端锁能保护不同窗口的读改写，但如果本窗口
   * 自己让旧请求和新请求并发，网络层仍可能让旧请求后到、覆盖新位置。队列同时覆盖
   * 500ms 防抖请求与卸载冲刷请求，失败只影响自己的错误反馈，不会截断后续保存。
   */
  const saveTailRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueSave = useCallback(
    (slug: string, values: Record<string, AssetTransform>, reportFailure: boolean) => {
      const request = saveTailRef.current
        .catch(() => undefined)
        .then(() => saveSceneTransforms(slug, values));
      saveTailRef.current = request;
      if (reportFailure) {
        void request.catch((err: unknown) => {
          onError?.(err instanceof Error ? err.message : String(err));
        });
      } else {
        void request.catch(() => {});
      }
    },
    [onError],
  );

  /** 删除前将防抖快照入队，并等待全部在途保存结束。 */
  const flushPendingSave = useCallback(
    () => {
      clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) enqueueSave(pending.slug, pending.transforms, false);
      return saveTailRef.current.catch(() => undefined);
    },
    [enqueueSave],
  );

  // 整份本地覆盖一起发（服务端是合并语义，重发已落盘的条目无副作用），
  // 省掉一套"哪些还没确认"的账；条目只有用户手动摆过的那几个，体积可忽略
  useEffect(() => {
    if (Object.keys(local).length === 0) {
      pendingRef.current = null;
      return;
    }
    const pending = { slug: projectSlug, transforms: local };
    pendingRef.current = pending;
    const timer = setTimeout(() => {
      if (pendingRef.current !== pending) return;
      pendingRef.current = null;
      enqueueSave(projectSlug, local, true);
    }, 500);
    timerRef.current = timer;
    return () => clearTimeout(timer);
  }, [local, projectSlug, enqueueSave]);

  /*
    卸载时冲刷还没写完的防抖：上面的 cleanup 只该取消"过时的那一班车"，
    不该把乘客一起扔掉——拖完模型 500ms 内退出工作台，摆好的位置就这么丢了，
    回来还会弹回默认位。这里立即补发；失败静默（组件都要没了，onError 无处可显）。
  */
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = null;
      enqueueSave(pending.slug, pending.transforms, false);
    },
    [projectSlug, enqueueSave],
  );

  return { transforms, commitTransforms, dropTransform, flushPendingSave };
}
