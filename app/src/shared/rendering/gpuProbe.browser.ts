/**
 * Browser console entry point for GPU frame timing.
 *
 * Real-GPU probe, run from the Vite app's console:
 *   const { startGpuFrameProbe } = await import('/src/shared/rendering/gpuProbe.browser.ts')
 *   const probe = startGpuFrameProbe(store, { label: 'mixed-single' })
 *   probe.result            // read after `durationMs`
 *   probe.stop()            // cancel early
 *
 * Reports real GPU execution time (Three's timestamp queries) alongside
 * wall-clock rAF intervals and CPU submit time, so "the GPU is busy" can be
 * separated from "the camera moved and everything was re-sorted".
 *
 * Requires timestamp tracking to have been on when the backend was built:
 * load the page with `?gpuTimestamps=1`.
 */
import { GpuFrameSampler, frameStats, syncCallStats, type GpuProbeResult, type GpuSyncCall } from "./gpuProbe";

type Vec3 = { x: number; y: number; z: number; clone(): Vec3; set(x: number, y: number, z: number): void };

interface ProbeCamera {
  isPerspectiveCamera?: boolean;
  position: Vec3;
  /** 正交相机的 up 各不相同（俯视图常用 (0,0,±1)）；还原时要写回 */
  up?: Vec3;
  lookAt(target: Vec3): void;
}

interface ProbeControl {
  enabled: boolean;
  object: ProbeCamera;
  target: Vec3;
}

interface ProbeRenderer {
  backend?: { trackTimestamp?: boolean; device?: { queue?: { submit?: (...args: never[]) => unknown } } };
  /** 取 webgpu 上下文用；同一个 canvas 上 `getContext("webgpu")` 返回同一个对象 */
  domElement?: { getContext?(id: string): unknown };
  render(scene: unknown, camera: unknown): void;
  resolveTimestampsAsync?(type?: string): Promise<number | undefined>;
  info?: { render?: { timestamp?: number; calls?: number; triangles?: number; points?: number } };
}

interface ProbeStore {
  getState(): {
    gl: ProbeRenderer;
    scene?: unknown;
    internal: { interaction: Array<{ __r3f?: { root: { getState(): { controls?: unknown; camera?: unknown } } } }> };
    /** 本应用所有 Canvas 都跑 "demand"；探针期间要临时切到 "always"（见下） */
    frameloop?: string;
    setFrameloop?(mode: string): void;
    invalidate?(): void;
  };
}


const ORIGIN: Vec3 = { x: 0, y: 0, z: 0, clone: () => ({ ...ORIGIN }), set() {} };

/** Rodrigues 旋转：把 v 绕单位轴 axis 转 angle */
function rotateAbout(v: { x: number; y: number; z: number }, axis: { x: number; y: number; z: number }, angle: number) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dot = v.x * axis.x + v.y * axis.y + v.z * axis.z;
  return {
    x: v.x * cos + (axis.y * v.z - axis.z * v.y) * sin + axis.x * dot * (1 - cos),
    y: v.y * cos + (axis.z * v.x - axis.x * v.z) * sin + axis.y * dot * (1 - cos),
    z: v.z * cos + (axis.x * v.y - axis.y * v.x) * sin + axis.z * dot * (1 - cos),
  };
}

/**
 * 让相机绕 `target` 转一点，返回新的相机位置。
 *
 * 旋转轴取**相机自身的右轴**（`forward × up`），不是世界 Y：
 * 俯视图里 forward 与 up 平行，绕世界 Y 转会让相机原地打转（视角不变 → 脏标记不触发 →
 * 等于没动）；而右轴与视线永远正交，转过去一定改变视角。
 * 两者都退化时（forward ∥ up 且没有可用的 up）退回世界 X。
 */
export function orbitOffset(
  position: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  up: { x: number; y: number; z: number } | undefined,
  angle: number,
) {
  const radius = { x: position.x - target.x, y: position.y - target.y, z: position.z - target.z };
  const forward = normalize({ x: -radius.x, y: -radius.y, z: -radius.z });
  const upVector = up ?? { x: 0, y: 1, z: 0 };
  let axis = cross(forward, upVector);
  if (length(axis) < 1e-3) axis = cross(forward, { x: 1, y: 0, z: 0 });
  if (length(axis) < 1e-3) axis = { x: 1, y: 0, z: 0 };
  axis = normalize(axis);
  const rotated = rotateAbout(radius, axis, angle);
  return { x: target.x + rotated.x, y: target.y + rotated.y, z: target.z + rotated.z };
}

function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function length(v: { x: number; y: number; z: number }) { return Math.hypot(v.x, v.y, v.z); }
function normalize(v: { x: number; y: number; z: number }) {
  const len = length(v) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}


/**
 * 给 GPU→CPU 同步挂计数器：`GPUBuffer.mapAsync` 与 `GPUQueue.onSubmittedWorkDone`。
 *
 * 为什么单独看这两个：它们都是"等 GPU 把那批命令做完"的入口，而 `await` 的等待时间
 * **既不出现在 LAF 的 script 时间、也不出现在 GPU 时间戳**里——正好是那个一直没人解释的桶。
 *
 * 挂的是原型，所以影响全局；返回的函数负责还原（探针收尾必调）。
 */
export function hookGpuSync(): {
  restore: () => void;
  calls: { mapAsync: number[]; onSubmitted: number[]; mapAsyncCallers: string[] };
} {
  const calls = { mapAsync: [] as number[], onSubmitted: [] as number[], mapAsyncCallers: [] as string[] };
  const restores: Array<() => void> = [];
  const globals = globalThis as unknown as {
    GPUBuffer?: { prototype: { mapAsync?: (...args: never[]) => Promise<unknown> } };
    GPUQueue?: { prototype: { onSubmittedWorkDone?: (...args: never[]) => Promise<unknown> } };
  };

  const time = (promise: Promise<unknown>, sink: number[]) => {
    const start = performance.now();
    return promise.then((value) => { sink.push(performance.now() - start); return value; },
      (error) => { sink.push(performance.now() - start); throw error; });
  };

  const bufferPrototype = globals.GPUBuffer?.prototype;
  if (bufferPrototype && typeof bufferPrototype.mapAsync === "function") {
    const original = bufferPrototype.mapAsync;
    bufferPrototype.mapAsync = function (this: unknown, ...args: never[]) {
      // 记调用方指纹（只记前 200 次，取栈里第一条不属于本探针的帧）
      if (calls.mapAsyncCallers.length < 200) {
        const stack = new Error().stack ?? "";
        const frame = stack.split("\n").map((line) => line.trim())
          .find((line) => line.startsWith("at ") && !line.includes("gpuProbe.browser"))
          ?? "unknown";
        calls.mapAsyncCallers.push(frame.replace(/^at\s+/, "").split(" (")[0]!.slice(0, 80));
      }
      return time(original.apply(this, args), calls.mapAsync);
    };
    restores.push(() => { bufferPrototype.mapAsync = original; });
  }

  const queuePrototype = globals.GPUQueue?.prototype;
  if (queuePrototype && typeof queuePrototype.onSubmittedWorkDone === "function") {
    const original = queuePrototype.onSubmittedWorkDone;
    queuePrototype.onSubmittedWorkDone = function (this: unknown, ...args: never[]) {
      return time(original.apply(this, args), calls.onSubmitted);
    };
    restores.push(() => { queuePrototype.onSubmittedWorkDone = original; });
  }

  return { restore: () => { for (const restore of restores) restore(); }, calls };
}

export interface GpuProbeOptions {
  label?: string;
  durationMs?: number;
  warmupMs?: number;
  /** Rotate the view cameras during the run. Omit to measure the settled frame. */
  motion?: boolean;
  /**
   * 动哪些窗格的相机。
   * - `"all"`（默认）：**所有**窗格，含正交的俯/前/右视图。多视图塌缩要看的是"每个视图各自
   *   重新排序"这条路径，而 GSL 的排序是脏标记驱动的——只动透视相机的话，另外三个正交视图
   *   完全静止、很可能根本不重排，测出来的多视图代价是假的。
   * - `"perspective"`：旧行为，只动透视相机；留着是为了能复现 2026-09-29 之前的轮次。
   */
  motionMode?: "all" | "perspective";
}

export interface GpuProbeRun {
  result: GpuProbeResult;
  stop(): GpuProbeResult;
}

/**
 * 转出报告格式化器，让控制台只 import 这一个模块就能打印归因
 * （见 `WEBGPU_PROBE_PROTOCOL.md` §4.1）。它本身仍是诊断代码，不进生产包。
 */
export { formatProbeReport } from "./gpuProbe";

/** Resolves the active WebGPU device from a renderer without importing R3F. */
/** 按出现次数取前 5 个调用方指纹 */
function topCallers(frames: readonly string[]): Array<{ frame: string; count: number }> {
  const counts = new Map<string, number>();
  for (const frame of frames) counts.set(frame, (counts.get(frame) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([frame, count]) => ({ frame, count }));
}

/** 把同步计数折成结果里的形状（含每帧次数） */
function syncStats(calls: { mapAsync: number[]; onSubmitted: number[]; mapAsyncCallers?: string[] }, frames: number) {
  const mapAsync: GpuSyncCall = syncCallStats(calls.mapAsync.length, calls.mapAsync);
  const onSubmitted: GpuSyncCall = syncCallStats(calls.onSubmitted.length, calls.onSubmitted);
  return {
    mapAsync,
    onSubmitted,
    mapAsyncPerWallFrame: frames ? mapAsync.calls / frames : 0,
    onSubmittedPerWallFrame: frames ? onSubmitted.calls / frames : 0,
    mapAsyncCallers: topCallers(calls.mapAsyncCallers ?? []),
  };
}

export function probeDeviceFrom(gl: unknown): unknown {
  const backend = (gl as { backend?: { device?: unknown } } | null | undefined)?.backend;
  return backend?.device ?? null;
}

export function startGpuFrameProbe(store: ProbeStore, options: GpuProbeOptions = {}): GpuProbeRun {
  const label = options.label ?? "gpu-frame";
  const durationMs = options.durationMs ?? 10_000;
  const warmupMs = options.warmupMs ?? 2_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(warmupMs) || warmupMs < 0) {
    throw new Error("Invalid GPU probe timing options.");
  }
  if (document.hidden) throw new Error("GPU probe requires a visible page.");

  const state = store.getState();
  const gl = state.gl;
  // The scene is needed to record what was actually drawn, so a run that
  // rendered nothing is reported as invalid instead of as a fast frame.
  const sampler = new GpuFrameSampler(gl, label, state.scene);
  if (!sampler.result.supported) {
    // Still validate caller options so a typo is reported as a typo.
    if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(warmupMs) || warmupMs < 0) {
      throw new Error("Invalid GPU probe timing options.");
    }
    throw new Error(sampler.result.unsupportedReason ?? "GPU timestamps unavailable.");
  }

  /*
    每个窗格是一个独立的 R3F root（`PaneCamera` 用 createPortal），所以相机要从每个 root 各取一份。
    **不能只取带 controls 的那些**：正交窗格不一定挂了 OrbitControls，而 moveto 只动透视相机的旧写法
    会让这些窗格整轮静止。
  */
  const panes = (state.internal.interaction ?? []).map((object) => {
    const rootState = object.__r3f?.root.getState();
    return { camera: rootState?.camera as ProbeCamera | undefined, control: rootState?.controls as ProbeControl | undefined };
  }).filter((pane): pane is { camera: ProbeCamera; control: ProbeControl | undefined } => Boolean(pane.camera?.position));

  const motionMode = options.motionMode ?? "all";
  const moving = motionMode === "perspective"
    ? panes.filter((pane) => pane.camera.isPerspectiveCamera)
    : panes;
  if (options.motion && !moving.length) throw new Error("GPU probe found no view cameras to move.");

  const snapshots = moving.map((pane) => ({
    camera: pane.camera,
    control: pane.control,
    enabled: pane.control?.enabled,
    position: pane.camera.position.clone(),
    up: pane.camera.up?.clone(),
    target: (pane.control?.target ?? ORIGIN).clone(),
  }));

  /*
    Whole-frame main-thread work.

    `cpuMs` below only wraps `renderer.render()`, so R3F reconciliation, every
    `useFrame` callback, and DOM event handlers are invisible to it — and that is
    precisely where a 33 ms frame can hide while the GPU reports 0.46 ms. Long
    Animation Frames is the only API that attributes all of a frame's callbacks
    together, and it also names forced style/layout, which is the cost of a
    synchronous `getBoundingClientRect()` on every pointer event.

    It only fires for frames over 50 ms, which is the population this probe
    exists to explain. Absent support, the field stays 0 and the run is still
    valid; it simply cannot attribute the main thread.
  */
  /*
    **只在采样窗口内记长帧。** `wall`/`gpu`/`cpuSubmit` 都是采样窗口（预热之后）的样本，
    如果长帧从探针启动就开始记，三个总量就不同窗口——4 视图那轮出现过
    `mainThread 10379 ms > wall 10067 ms` 的荒谬结果，`unexplained` 因此变成负数。

    LAF 是异步投递的，边界那一帧可能被算进相邻窗口；这是毫秒级误差，可以接受。
  */
  let samplingWindow = false;
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== "undefined"
    && PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
    try {
      observer = new PerformanceObserver((list) => {
        if (!samplingWindow) return;
        for (const entry of list.getEntries()) {
          const frame = entry as PerformanceEntry & {
            blockingDuration?: number;
            scripts?: Array<{ duration?: number; forcedStyleAndLayoutDuration?: number }>;
          };
          const scripts = frame.scripts ?? [];
          sampler.recordLongFrame({
            duration: entry.duration,
            blockingDuration: frame.blockingDuration ?? 0,
            forcedStyleAndLayoutDuration: scripts.reduce(
              (sum, script) => sum + (script.forcedStyleAndLayoutDuration ?? 0), 0),
            /*
              脚本时间：该长帧内所有 script 条目 duration 之和。这是**唯一**能和 GPU/wall
              同窗口比较的主线程工作量——`entry.duration` 是帧持续时间，与帧间隔几乎同义，
              用它会变成"拿帧间隔解释帧间隔"。
            */
            scriptDuration: scripts.reduce(
              (sum, script) => sum + (script.duration ?? 0), 0),
          });
        }
      });
      observer.observe({ type: "long-animation-frame", buffered: false });
    } catch {
      observer = null;
    }
  }

  /*
    呈现 / 提交 / 渲染调用计数。

    帧间隔永远是 vsync 的整数倍，而同一轮里 GPU 只占两到五成、JS 近零——所以要问
    "那几个 vsync 里应用在等什么"。这三个计数把问题变成可判定的：
    - `getCurrentTexture`：呈现了几次（每次呈现都要取当前纹理）；
    - `queue.submit`：命令缓冲提交了几批；
    - `gl.render`：应用主动渲染了几次（本应用每个窗格至少一次）。
    分别除以 rAF 帧数，就能区分"每帧一次"与"每视图一次"。

    **必须在采样窗口内计数。** 这三个数最终都除以 `wallFrames`，而 `wallFrames` 只覆盖
    预热之后的窗口；如果分子从探针启动（含 2 s 预热）就开始累加，预热期的任何绘制都会把
    "每帧"数抬高，而分母不含那段。实测代价：同一配置两次运行给出 `renders=9.85` 与
    `renders=15.76`（load 都是 4.1），看起来像"结构性差异"，其实只是预热窗口不同。
    这与长帧归因踩过的是同一个坑（见 §5.13 对 `mainThreadTotalMs` 的窗口修正）。
  */
  const counters = { presents: 0, submits: 0, renders: 0 };
  /** 每次取画布纹理的时刻；有上限，避免长跑撑爆内存（5000 次 ≈ 几秒的 4 视图） */
  const presentTimes: number[] = [];
  const restoreHooks: Array<() => void> = [];
  const context = gl.domElement?.getContext?.("webgpu") as { getCurrentTexture?: (...args: never[]) => unknown } | undefined;
  if (context && typeof context.getCurrentTexture === "function") {
    const original = context.getCurrentTexture;
    context.getCurrentTexture = function (this: unknown, ...args: never[]) {
      if (samplingWindow) {
        counters.presents += 1;
        if (presentTimes.length < 5000) presentTimes.push(performance.now());
      }
      return original.apply(this, args);
    };
    restoreHooks.push(() => { context.getCurrentTexture = original; });
  }
  const syncHook = hookGpuSync();
  const queue = gl.backend?.device?.queue;
  if (queue && typeof queue.submit === "function") {
    const original = queue.submit;
    queue.submit = function (this: unknown, ...args: never[]) {
      if (samplingWindow) counters.submits += 1;
      return original.apply(this, args);
    };
    restoreHooks.push(() => { queue.submit = original; });
  }

  // CPU submit time: how long `renderer.render()` occupies the main thread.
  // Explicitly NOT GPU time, reported side by side with it.
  const originalRender = gl.render;
  let cpuMs = 0;
  const measuredRender = function (this: unknown, ...args: [scene: unknown, camera: unknown]) {
    const start = performance.now();
    // 同样只在采样窗口内计数：这个数最后要除以 `wallFrames`（见上面 io 计数的说明）
    if (samplingWindow) counters.renders += 1;
    try { return originalRender.apply(this, args); }
    finally { cpuMs += performance.now() - start; }
  };
  gl.render = measuredRender as ProbeRenderer["render"];

  const started = performance.now();
  let last = started;
  let raf = 0;
  let finished = false;

  /*
    **本应用跑 `frameloop="demand"`。** 静止场景下一帧都不会提交，时间戳查询池也就不会累积，
    于是探针会看到"墙钟跑了 600 帧、GPU 样本 0 个"——那不是仪器坏了，是根本没有绘制。

    `motion` 只改相机也不会触发绘制：demand 循环要 `invalidate()` 才会画。所以这里和
    `benchmark.browser.js` 用同一套办法：探针期间临时切到 `"always"`，结束时还原。

    代价要说清楚：这测的是"**每帧都提交绘制**的代价"，与应用的 on-demand 静止行为不同。
    墙钟那一列不受影响（它本来就被 vsync 钉住），受影响的是 GPU / cpuSubmit / 长帧归因。
  */
  const previousLoop = state.frameloop;
  const setFrameloop = state.setFrameloop;
  if (typeof setFrameloop === "function") setFrameloop.call(state, "always");

  const onVisibilityChange = () => { if (document.hidden) finish("Page became hidden during the probe"); };
  document.addEventListener("visibilitychange", onVisibilityChange);

  function finish(reason: string | null): GpuProbeResult {
    if (finished) return sampler.result;
    finished = true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    observer = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (gl.render === (measuredRender as unknown)) gl.render = originalRender;
    for (const snapshot of snapshots) {
      if (snapshot.control) snapshot.control.enabled = snapshot.enabled ?? true;
      // 动过的相机要放回去：否则探针结束后视口停在一个用户没选过的机位
      snapshot.camera.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
      if (snapshot.up && snapshot.camera.up) snapshot.camera.up.set(snapshot.up.x, snapshot.up.y, snapshot.up.z);
      if (snapshot.control) snapshot.control.target.set(snapshot.target.x, snapshot.target.y, snapshot.target.z);
    }
    // 还原渲染循环：只在画布仍是当初那一个时动它（切项目/重挂载后不该去改新画布）
    if (store.getState().gl === gl && typeof setFrameloop === "function") {
      setFrameloop.call(state, previousLoop ?? "demand");
      state.invalidate?.();
    }
    for (const restore of restoreHooks) restore();
    syncHook.restore();
    const result = sampler.stop(reason);
    const frames = result.attribution.wallFrames;
    result.io = {
      presents: counters.presents,
      submits: counters.submits,
      renders: counters.renders,
      presentsPerWallFrame: frames ? counters.presents / frames : 0,
      submitsPerWallFrame: frames ? counters.submits / frames : 0,
      rendersPerWallFrame: frames ? counters.renders / frames : 0,
      // 相邻间隔：把时刻两两相减。它是"呈现是否被 vsync 卡住"的判据
      presentGapMs: frameStats(presentTimes.slice(1).map((time, index) => time - presentTimes[index]!)),
      sync: syncStats(syncHook.calls, frames),
    };
    return result;
  }

  const frame = (now: number) => {
    if (finished) return;
    const elapsed = now - started;
    const interval = now - last;
    // Skip the first interval after warmup so it cannot span the warmup edge.
    const sampling = elapsed >= warmupMs && last - started >= warmupMs;
    samplingWindow = sampling;
    const submitMs = cpuMs;
    cpuMs = 0;
    last = now;
    if (sampling) void sampler.sample(interval, submitMs);
    if (options.motion) {
      const angle = elapsed / 1000 * 0.35;
      for (const snapshot of snapshots) {
        const orbit = orbitOffset(snapshot.position, snapshot.target, snapshot.up, angle);
        snapshot.camera.position.set(orbit.x, orbit.y, orbit.z);
        snapshot.camera.lookAt(snapshot.target);
      }
    }
    if (elapsed >= warmupMs + durationMs) { finish(null); return; }
    raf = requestAnimationFrame(frame);
  };

  const result: GpuProbeRun = {
    get result() { return sampler.result; },
    stop: () => finish("Probe cancelled"),
  };
  raf = requestAnimationFrame(frame);
  return result;
}
