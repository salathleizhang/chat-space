/**
 * GPU frame timing for ChatSpace.
 *
 * Uses Three.js's own timestamp-query support (`WebGPUBackend.trackTimestamp`),
 * which attaches `timestampWrites` to each render pass descriptor and exposes
 * the resolved total through `resolveTimestampsAsync()`. That is the only
 * supported route on this stack: `timestampWrites` is a render/compute pass
 * descriptor field, NOT a `GPUQueue.submit` field, and Three builds its passes
 * internally.
 *
 * Real GPU time is required to answer the question rAF intervals cannot: when a
 * frame costs 100ms, how much is the GPU actually executing versus the CPU
 * submitting, versus the frame simply not being presented yet.
 *
 * Frame intervals (rAF) and CPU submit time are NOT GPU time.
 */

export interface GpuTimestampSource {
  /** Three's `WebGPURenderer.resolveTimestampsAsync`. Resolves GPU ms. */
  resolveTimestampsAsync(type?: string): Promise<number | undefined>;
  /**
   * Three's `Renderer.info`.
   *
   * `render.frameCalls` / `drawCalls` / `triangles` / `points` are per-frame
   * counters *only while three owns the animation loop* — `Info.reset()` is
   * called from `Animation`, and this app renders through R3F's own rAF loop,
   * so in practice they accumulate for the page's lifetime. `render.calls` is
   * worse than that: `Info.reset()` never clears it at all (only `dispose()`
   * does) and `Geometries` uses it as a monotonic call id, so it is not a
   * draw-call count on any app. Always read the per-frame field and diff it.
   */
  info?: {
    render?: { timestamp?: number; calls?: number; frameCalls?: number; drawCalls?: number; triangles?: number; points?: number };
    compute?: { calls?: number; frameCalls?: number; timestamp?: number };
  };
  backend?: {
    trackTimestamp?: boolean;
    getTimestampFrames?(type?: string): number[];
    /** Three's per-type timestamp query pool; used to tell "no frames" from "all zero". */
    timestampQueryPool?: Record<string, { currentQueryIndex?: number; lastValue?: number } | null>;
  };
  /** Three's `Object3D`. Used only to record what was actually drawn. */
  traverse?(callback: (object: SplatDrawable) => void): void;
}

/** Structurally satisfied by a Gaussian Splat Lite renderer in the scene graph. */
export interface SplatDrawable {
  visible?: boolean;
  activeSplats?: number;
  geometry?: { instanceCount?: number };
}

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * 帧预算闭合：**整轮的总量**，不是分位数。
 *
 * 为什么需要它：分位数回答不了"3 视图下帧间隔 3183 ms，而计时的 GPU 工作只有 362 ms，
 * 剩下的去哪了"。总量 + 覆盖帧数才能把这一轮的时间归到三方：已计时的 GPU 工作、主线程工作、
 * 以及**两者都没解释掉的部分**（`unexplainedMs`）。
 *
 * 读它之前先记住三件事，否则会误读：
 * ① `mainThread*` 只来自 Long Animation Frames，也就是**只统计超过 50 ms 的帧**——
 *    它天然是"长帧主线程总量"，不是全部帧的总和；
 * ② GPU 时长只在解析成功的帧上存在，`gpuFrames` 可能远小于 `wallFrames`；
 *    两者差得多时 GPU 总量是**低估**的，先看覆盖帧数再下结论；
 * ③ 主线程与 GPU 是并行的（GPU 异步执行，主线程只负责提交），所以两侧总量**不能相加**，
 *    `unexplainedMs` 按"完全重叠"这个最保守的假设去减。
 */
/** 探针期间观察到的 I/O 调用次数；分位数与总量都无法表达"每帧发生几次"。 */
export interface ProbeIoCounters {
  presents: number;
  submits: number;
  renders: number;
  presentsPerWallFrame: number;
  submitsPerWallFrame: number;
  rendersPerWallFrame: number;
  /**
   * **相邻两次"取当前纹理"的间隔**。这是把"那 2–9 个 vsync 里在等什么"变成可判定的关键：
   * 若 p50 ≈ 16.7 ms（一个 vsync 周期），说明每次呈现都在等 vsync，帧时间 ≈ 呈现次数 × vsync；
   * 若远小于它，呈现是排在一起的，等待发生在别处。
   *
   * 口径提醒：量的是 `getCurrentTexture` 的调用间隔。Three 可能在呈现之外也调用它，
   * 所以它是"画布纹理获取"的间隔，**不等于**严格的呈现间隔；要坐实需要别的证据。
   */
  presentGapMs: FrameStats;
  /**
   * GPU→CPU 同步调用：每帧调用几次、平均等多久。
   *
   * 为什么单列：`await` 一个 promise 既**不算** LAF 的 script 时间、也**不算** GPU 时间——
   * 它正好落进"谁都没解释"的那个桶。如果这里每帧一次、平均等几十毫秒，
   * 那帧间隔的量级就有了解释（与"GSL 每帧同步排序"的说法吻合）。
   */
  sync: {
    mapAsync: GpuSyncCall;
    onSubmitted: GpuSyncCall;
    mapAsyncPerWallFrame: number;
    onSubmittedPerWallFrame: number;
    /**
     * `mapAsync` 的调用方指纹（栈里第一条非探针帧），按次数排序取前几名。
     *
     * 为什么必须看这个：回读等待占了墙钟的绝大部分，但**"谁在回读"决定了它是不是塌缩的原因**——
     * 可能是 splat 排序的同步路径，也可能是缩略图/检查图的截图队列。只看总时长会把两者混为一谈。
     */
    mapAsyncCallers: Array<{ frame: string; count: number }>;
  };
}

export interface GpuSyncCall {
  calls: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
}

function emptySyncCall(): GpuSyncCall { return { calls: 0, totalMs: 0, meanMs: 0, maxMs: 0 }; }
export function syncCallStats(calls: number, durations: readonly number[]): GpuSyncCall {
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  return { calls, totalMs, meanMs: calls ? totalMs / calls : 0, maxMs: durations.length ? Math.max(...durations) : 0 };
}

function emptyIoCounters(): ProbeIoCounters {
  return {
    presents: 0, submits: 0, renders: 0,
    presentsPerWallFrame: 0, submitsPerWallFrame: 0, rendersPerWallFrame: 0,
    presentGapMs: frameStats([]),
    sync: {
      mapAsync: emptySyncCall(), onSubmitted: emptySyncCall(),
      mapAsyncPerWallFrame: 0, onSubmittedPerWallFrame: 0, mapAsyncCallers: [],
    },
  };
}

export interface ProbeAttribution {
  /** 计入 wall 总量的帧数（每次 `sample()` 一帧，含被跳过的帧） */
  wallFrames: number;
  /** 解析出 GPU 时长的帧数 */
  gpuFrames: number;
  /** 解析出 compute（splat 投影/排序）时长的帧数 */
  computeFrames: number;
  /** 上报 Long Animation Frame 的帧数，即长帧数 */
  mainThreadFrames: number;
  wallTotalMs: number;
  gpuTotalMs: number;
  computeTotalMs: number;
  cpuSubmitTotalMs: number;
  mainThreadTotalMs: number;
  blockingTotalMs: number;
  forcedLayoutTotalMs: number;
  /**
   * 各population 的**均值**。三个总量来自不同分母（墙钟每帧、GPU 只在解析出来的帧、
   * 长帧只在 >50 ms 的帧），所以**不能相加**，要比较就用这几列。
   */
  wallMeanMs: number;
  gpuMeanMs: number;
  mainThreadMeanMs: number;
  /**
   * `wallTotal − max(gpu + compute, mainThread)`。
   *
   * **正数才是缺口**。≤ 0 表示这一轮的帧时间已经被 GPU 或主线程占满，不需要第三个解释。
   *
   * ⚠️ 只有当三个总量**同窗口同分母**时才有意义：`wall`/`gpu`/`cpuSubmit` 只记采样窗口，
   * 所以长帧也必须只记采样窗口（浏览器入口已按此门控）；而 `gpu` 只在解析成功的帧上存在，
   * 覆盖率低时它是低估的。先看 `gpuFrames/wallFrames`，再决定要不要读这一项。
   *
   * **想比较就用 `paired*`**：上面这个总量混了两个分母（见 `pairedWindows` 的说明）。
   */
  unexplainedMs: number;
  /**
   * 按**窗口**配对的样本数。一个窗口 = 两次 `resolveTimestampsAsync` 调用之间。
   *
   * 为什么需要它：应用每渲染一帧只提交一批时间戳查询，而 Three 的查询池在
   * `_resolveQueries` **入口**就快照并清空（`three.webgpu.js` 的 `_resolveQueries`：
   * `currentOffsets = new Map(queryOffsets)` → `currentQueryIndex = 0`），所以一次
   * resolve 返回的是"自上次 resolve 以来"的**总和**，而两次 resolve 之间可能隔着好几个
   * rAF 采样。把这一次总和配上一个 rAF 间隔，就是拿两个分母相减。
   *
   * 探针改为在**发起 resolve 的同一刻**对 wall 做快照：窗口边界与 Three 的快照点一致，
   * 于是 `pairedWall*` 与 `pairedGpu*` 覆盖同一段区间，可以直接比。
   */
  pairedWindows: number;
  pairedWallTotalMs: number;
  /** **只含 render 池**（配对窗口内）。要用"GPU 总占用"请用 `gpuUtilization` */
  pairedGpuTotalMs: number;
  /** 配对窗口内的 compute 池（splat 投影 / 排序）；只在两侧样本数一致时计入 */
  pairedComputeTotalMs: number;
  pairedComputeMeanMs: number;
  /** 每个配对窗口的均值。**这两个数同分母，可以比**——`wallMeanMs`/`gpuMeanMs` 不行。 */
  pairedWallMeanMs: number;
  pairedGpuMeanMs: number;
  /**
   * `(pairedGpuTotalMs + pairedComputeTotalMs) / pairedWallTotalMs`——这段窗口里 **GPU 的占用率，
   * 含 render 与 compute 两个池**。
   *
   * 为什么必须含 compute：splat 的投影与排序跑在 compute 池里，而 Three 把它们的时间戳写进
   * **另一个查询池**。只算 render 会让"GPU 占用率"系统性偏低——正是这个应用最需要看准的地方。
   * ≈1 表示 GPU 一直在执行（GPU-bound）；≪1 表示 GPU 在等别的东西。
   * `null` 表示没有配对样本。
   */
  gpuUtilization: number | null;
  /** 配对窗口里的 CPU 提交总量（同一窗口，可与 GPU 直接比大小）。 */
  pairedCpuTotalMs: number;
  /**
   * 长帧里脚本占用的总时长（同一采样窗口，可与 `wallTotalMs` 直接比）。
   *
   * **这是唯一能指认"是不是主线程在限速"的量。** 不要用 `mainThreadTotalMs`：
   * 它来自 Long Animation Frame 的 `duration`，那是帧持续时间，与帧间隔几乎同义。
   */
  scriptTotalMs: number;
  /** 每个长帧的脚本均值。 */
  scriptMeanMs: number;
  /** `scriptTotalMs / wallTotalMs`。接近 1 = JS 占满主线程；远小于 1 = 不是 JS。 */
  scriptShareOfWall: number | null;
}

function emptyAttribution(): ProbeAttribution {
  return {
    wallFrames: 0, gpuFrames: 0, computeFrames: 0, mainThreadFrames: 0,
    wallTotalMs: 0, gpuTotalMs: 0, computeTotalMs: 0, cpuSubmitTotalMs: 0,
    mainThreadTotalMs: 0, blockingTotalMs: 0, forcedLayoutTotalMs: 0,
    wallMeanMs: 0, gpuMeanMs: 0, mainThreadMeanMs: 0, unexplainedMs: 0,
    pairedWindows: 0, pairedWallTotalMs: 0, pairedGpuTotalMs: 0, pairedComputeTotalMs: 0, pairedComputeMeanMs: 0,
    pairedWallMeanMs: 0, pairedGpuMeanMs: 0, gpuUtilization: null, pairedCpuTotalMs: 0,
    scriptTotalMs: 0, scriptMeanMs: 0, scriptShareOfWall: null,
  };
}

const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);
/** population 为空时返回 0，而不是 NaN——报告里出现 NaN 只会让人以为仪器坏了 */
const mean = (values: readonly number[]) => (values.length ? total(values) / values.length : 0);

/** 把一轮的总量折成帧预算闭合。纯函数，便于单测直接喂数字。 */
export function buildAttribution(input: {
  wall: readonly number[];
  gpu: readonly number[];
  compute: readonly number[];
  cpuSubmit: readonly number[];
  mainThread: readonly number[];
  blocking: readonly number[];
  forcedLayout: number;
  /**
   * 与 `gpu` **一一对应**的窗口 wall 时长（同一索引 = 同一窗口）。缺省为空数组，
   * 此时配对统计为 0/null——旧调用方不会因此拿到错的数。
   */
  pairedWall?: readonly number[];
  /** 与 `pairedWall` 一一对应的窗口 CPU 提交时长。 */
  pairedCpu?: readonly number[];
  /** 长帧里的脚本时长（`scripts[].duration`）。缺省为空数组 → 脚本统计为 0/null。 */
  script?: readonly number[];
}): ProbeAttribution {
  const wallTotalMs = total(input.wall);
  const gpuTotalMs = total(input.gpu);
  const computeTotalMs = total(input.compute);
  const mainThreadTotalMs = total(input.mainThread);
  /*
    配对统计只在两侧长度一致时采信。它们本应恒等（探针在同一次 resolve 里同时压入），
    但纯函数不该假设调用方一定对齐——错位的一对会给出看起来合理的假比率。
  */
  const pairedWall = input.pairedWall ?? [];
  const pairedCpu = input.pairedCpu ?? [];
  const pairedWindows = pairedWall.length === input.gpu.length ? input.gpu.length : 0;
  const script = input.script ?? [];
  const scriptTotalMs = total(script);
  const pairedWallTotalMs = pairedWindows ? total(pairedWall) : 0;
  const pairedGpuTotalMs = pairedWindows ? gpuTotalMs : 0;
  /*
    compute 只在**两侧样本数一致**时计入：探针在同一次 sample 里解析两个池，正常情况下一一对应；
    数量不齐说明这一轮的配对不成立，此时宁可只报 render，也不要拼一个假的总量。
  */
  const pairedComputeTotalMs = pairedWindows && input.compute.length === input.gpu.length ? computeTotalMs : 0;
  return {
    wallFrames: input.wall.length,
    gpuFrames: input.gpu.length,
    computeFrames: input.compute.length,
    mainThreadFrames: input.mainThread.length,
    wallTotalMs,
    gpuTotalMs,
    computeTotalMs,
    cpuSubmitTotalMs: total(input.cpuSubmit),
    mainThreadTotalMs,
    blockingTotalMs: total(input.blocking),
    forcedLayoutTotalMs: input.forcedLayout,
    wallMeanMs: mean(input.wall),
    gpuMeanMs: mean(input.gpu),
    mainThreadMeanMs: mean(input.mainThread),
    unexplainedMs: wallTotalMs - Math.max(gpuTotalMs + computeTotalMs, mainThreadTotalMs),
    pairedWindows,
    pairedWallTotalMs,
    pairedGpuTotalMs,
    pairedComputeTotalMs,
    pairedComputeMeanMs: pairedWindows ? pairedComputeTotalMs / pairedWindows : 0,
    pairedWallMeanMs: pairedWindows ? pairedWallTotalMs / pairedWindows : 0,
    pairedGpuMeanMs: pairedWindows ? pairedGpuTotalMs / pairedWindows : 0,
    gpuUtilization: pairedWindows && pairedWallTotalMs > 0
      ? (pairedGpuTotalMs + pairedComputeTotalMs) / pairedWallTotalMs
      : null,
    pairedCpuTotalMs: pairedWindows ? total(pairedCpu) : 0,
    scriptTotalMs,
    scriptMeanMs: mean(script),
    scriptShareOfWall: wallTotalMs > 0 ? scriptTotalMs / wallTotalMs : null,
  };
}

/**
 * 把一轮结果排成可直接贴进控制台/文档的多行报告。
 *
 * 为什么存在这个东西：`long-animation-frame` 的归因一直只躺在结果对象里，**从没被报出来过**，
 * 于是"3 视图 3183 ms 帧间隔 vs 362 ms 已计时 GPU"这个缺口始终没有第三方解释
 * （见 AGENTS.md 第六节）。跑完探针把这段贴出来，缺口就落到 `unexplained` 一行上。
 */
export function formatProbeReport(result: GpuProbeResult): string {
  const attribution = result.attribution;
  const ms = (value: number) => value.toFixed(1);
  const lines = [
    `[gpu-probe] ${result.label}`,
    `valid=${result.valid} done=${result.done} elapsed=${(result.elapsedMs / 1000).toFixed(1)}s`
      + (result.error ? ` error=${result.error}` : ""),
    `frames: wall=${attribution.wallFrames} gpuCoverage=${attribution.gpuFrames}/${attribution.wallFrames}`
      + ` compute=${attribution.computeFrames} longFrames=${attribution.mainThreadFrames}`,
    `totals(ms): wall=${ms(attribution.wallTotalMs)} gpu=${ms(attribution.gpuTotalMs)}`
      + ` compute=${ms(attribution.computeTotalMs)} mainThread=${ms(attribution.mainThreadTotalMs)}`
      + ` cpuSubmit=${ms(attribution.cpuSubmitTotalMs)}`,
    `mainThread detail(ms): blocking=${ms(attribution.blockingTotalMs)}`
      + ` forcedLayout=${ms(attribution.forcedLayoutTotalMs)}`,
    /*
      脚本时间：唯一能与 GPU / wall 并列比较的"主线程工作"。上面 mainThread 用的是 Long
      Animation Frame 的 `duration`，那本身就是该长帧的持续时间（≈帧间隔），拿它去解释
      帧间隔是循环论证。判限速方只看这一行。
    */
    `scripts(ms): total=${ms(attribution.scriptTotalMs)}`
      + ` perLongFrame=${ms(attribution.scriptMeanMs)}`
      + ` shareOfWall=${attribution.scriptShareOfWall === null ? "n/a" : (attribution.scriptShareOfWall * 100).toFixed(0) + "%"}`
      + `   (shareOfWall≈100% = JS 占满主线程；≪100% = 不是 JS 在限速)`,
    `means(ms): wall=${ms(attribution.wallMeanMs)} gpu=${ms(attribution.gpuMeanMs)}`
      + ` mainThread=${ms(attribution.mainThreadMeanMs)}   (各 population 的均值，别相加)`,
    /*
      这一行才是"GPU 与 wall 同一分母"的比较。上面那行 means 的三个数来自三个不同
      population（wall 每帧、gpu 只在解析出来的帧、mainThread 只在 >50 ms 的帧），
      直接相减等于拿两个分母做差——这正是"3 视图 362 ms 解释不了 3183 ms"那个
      缺口的来源（见 AGENTS.md 第六节）。
    */
    `paired(ms): windows=${attribution.pairedWindows}`
      + ` wall=${ms(attribution.pairedWallTotalMs)} gpu=${ms(attribution.pairedGpuTotalMs)}`
      + ` cpuSubmit=${ms(attribution.pairedCpuTotalMs)}`
      + `  → perWindow wall=${ms(attribution.pairedWallMeanMs)} gpu=${ms(attribution.pairedGpuMeanMs)}`,
    `gpuUtilization=${attribution.gpuUtilization === null ? "n/a" : (attribution.gpuUtilization * 100).toFixed(0) + "%"}`
      + `   (pairedGpu/pairedWall；≈100% = GPU-bound，≪100% = GPU 在等)`,
    `unexplained=${ms(attribution.unexplainedMs)}ms   (wall − max(gpu+compute, mainThread)，混合分母，仅供参考)`,
    `p50/p95/max(ms): wall=${ms(result.wallMs.p50)}/${ms(result.wallMs.p95)}/${ms(result.wallMs.max)}`
      + ` gpu=${ms(result.gpuMs.p50)}/${ms(result.gpuMs.p95)}/${ms(result.gpuMs.max)}`,
    `draw: views=${result.visibleViews} instances=${result.totalInstanceCount} splats=${result.activeSplats}`,
  ];
  if (result.io.presents || result.io.submits || result.io.renders) {
    lines.push(`io per rAF frame: presents=${result.io.presentsPerWallFrame.toFixed(2)}`
      + ` submits=${result.io.submitsPerWallFrame.toFixed(2)} renders=${result.io.rendersPerWallFrame.toFixed(2)}`
      + `   (totals: ${result.io.presents}/${result.io.submits}/${result.io.renders})`);
    if (result.io.sync.mapAsync.calls || result.io.sync.onSubmitted.calls) {
      const format = (call: typeof result.io.sync.mapAsync, perFrame: number) =>
        `${call.calls} 次（${perFrame.toFixed(2)}/帧，mean ${ms(call.meanMs)} ms，max ${ms(call.maxMs)} ms）`;
      if (result.io.sync.mapAsyncCallers.length) {
        lines.push(`io mapAsync callers: ${result.io.sync.mapAsyncCallers.map((entry) => `${entry.count}× ${entry.frame}`).join(" | ")}`);
      }
      lines.push(`io gpu→cpu sync per run: mapAsync ${format(result.io.sync.mapAsync, result.io.sync.mapAsyncPerWallFrame)}`
        + ` | onSubmittedWorkDone ${format(result.io.sync.onSubmitted, result.io.sync.onSubmittedPerWallFrame)}`);
    }
    if (result.io.presentGapMs.frames > 0) {
      lines.push(`present gap(ms): p50=${ms(result.io.presentGapMs.p50)} p95=${ms(result.io.presentGapMs.p95)}`
        + ` max=${ms(result.io.presentGapMs.max)} over ${result.io.presentGapMs.frames} gaps`
        + `   (≈16.7 = 每次呈现都在等一个 vsync)`);
    }
  }
  /*
    覆盖不足**不等于**仪器可疑：应用每帧只提交一次查询，而探针按 rAF 采样。帧变慢时
    （例如 4 视图 130 ms/帧）探针每个应用帧会采到好几个"没有新查询"的样本，覆盖率自然低。

    要点：**比较请用 `paired` 那一行**，它已经按窗口把两侧放到同一分母；上面
    `means` 那一行的 wall 与 gpu 分母不同，`unexplained` 也一样。
  */
  if (attribution.gpuFrames < attribution.wallFrames) {
    const perWindow = attribution.wallMeanMs > 0
      ? (attribution.pairedWallMeanMs / attribution.wallMeanMs).toFixed(1)
      : "0";
    lines.push(
      `note: GPU resolved on ${attribution.gpuFrames}/${attribution.wallFrames} rAF samples — the app submits one batch per rendered frame`
      + ` while this probe samples every rAF, so a slow frame yields several empty samples.`
      + ` ${attribution.pairedWindows} of those resolutions carried a matched wall window`
      + ` (avg ${perWindow} rAF samples per window).`
      + ` Compare the paired line, not the mixed-denominator means.`);
  }
  if (!result.valid) {
    lines.push("warn: this run is not a valid measurement; do not quote its numbers.");
  }
  return lines.join("\n");
}

export interface GpuProbeResult {
  label: string;
  supported: boolean;
  unsupportedReason: string | null;
  done: boolean;
  valid: boolean;
  error: string | null;
  started: number;
  elapsedMs: number;
  /** Frames where a resolved render-pool GPU duration was available. */
  gpuSamples: number;
  /** Three's `info.render.timestamp` matches `gpuMs` when tracking is live. */
  renderInfoTimestamp: number;
  gpuMs: FrameStats;
  wallMs: FrameStats;
  cpuSubmitMs: FrameStats;
  /**
   * The compute pass pool. GSL's splat projection and radix sort are submitted
   * with `renderer.compute()`, and three writes their timestamps into a
   * *separate* query pool, so `gpuMs` structurally excludes them. A frame can
   * look cheap in `gpuMs` while the sort owns the whole frame budget.
   */
  computeSamples: number;
  computeMs: FrameStats;
  /** Compute ms as a share of the wall-clock frame interval at P50. */
  computeShareOfP50: number | null;
  /** Render + compute GPU ms as a share of the wall-clock frame interval at P50. */
  gpuShareOfP50: number | null;
  /**
   * Per-frame peaks, read as deltas (see `GpuTimestampSource.info`). `0` means
   * either nothing was drawn or the counter was unavailable — never a claim
   * that no work happened.
   */
  renderCalls: number;
  triangles: number;
  points: number;
  samples: number[];
  /** Resolved compute-pool durations, one entry per accepted sample. */
  computeSamplesMs: number[];
  /**
   * Whole-frame main-thread work from Long Animation Frames. `cpuSubmitMs` only
   * wraps `renderer.render()`, so R3F reconciliation, `useFrame` callbacks and
   * DOM event handlers are invisible to it; these are not.
   */
  mainThreadFrames: number;
  mainThreadMs: FrameStats;
  /** The part of main-thread work that delayed input/paint response. */
  blockingMs: FrameStats;
  /** Total forced style/layout time (synchronous reflows such as per-event `getBoundingClientRect`). */
  forcedLayoutMs: number;
  /**
   * 长帧里脚本占用的总时长（`scripts[].duration` 之和，只统计 >50 ms 的帧）。
   *
   * 这是唯一能与 GPU / wall 并列比较的"主线程工作"字段。不要用 `mainThreadMs` 干这件事：
   * 它用的是 Long Animation Frame 的 `duration`，那本身就是该长帧的持续时间，≈帧间隔。
   */
  scriptTotalMs: number;
  scriptMs: FrameStats;
  /**
   * 整轮的帧预算闭合（总量 + 覆盖帧数 + 没被解释掉的差额）。分位数回答不了
   * "3 视图 3183 ms 的帧间隔里，计时的 GPU 只占 362 ms，其余在哪"，这个块可以。
   */
  attribution: ProbeAttribution;
  /**
   * 呈现 / 命令提交 / 渲染调用的计数（浏览器入口挂的钩子；不在浏览器里跑就全是 0）。
   *
   * 为什么要这三个：帧间隔永远是 vsync 的整数倍，而 GPU 只占两到五成、JS 近零，
   * 剩下的问题就是"那几个 vsync 里应用在等什么"。把这三个数除以 rAF 帧数，
   * 就能看出它是"每帧一次"还是"每视图一次"——这正是"每视图各等一次呈现"假设的判据。
   */
  io: ProbeIoCounters;
  /**
   * Splat draw context, so a run cannot be reported as a valid measurement when
   * nothing was actually drawn. The 30-minute stability record contains a
   * "0 drawing instances" failure that a GPU-time-only report would have shown
   * as a suspiciously fast frame instead of a broken one.
   */
  visibleViews: number;
  totalInstanceCount: number;
  activeSplats: number;
  invalidation: { reason: string; at: number } | null;
}

export const GPU_PROBE_UNSUPPORTED =
  "Timestamp tracking is off for this renderer. Enable it before the WebGPU backend is constructed " +
  "(NativeWebGPURenderer.trackTimestamp, or the ?gpuTimestamps=1 page query) and reload.";

/**
 * A run whose every resolved duration is 0 ms is this environment's failure
 * signature, not a fast GPU. Measured on Chrome 154 / macOS: Three's
 * render-pass timestamps resolve fine in a *visible* window (1 vs 800 draws
 * gave 0.26 ms vs 7.60 ms), but a headless instance produced 0 ms for
 * everything including a known-heavy load. Never report all-zero as a result.
 */

export const GPU_PROBE_ALL_ZERO =
  "Every resolved GPU duration was 0 ms, which this environment also produces when timestamps are " +
  "silently unavailable. The run is not a valid measurement.";

/**
 * A resolved duration above this is not a slow frame, it is a broken number.
 * Timestamp counters are `BigUint64` nanoseconds and the hardware occasionally
 * resets them; three's `Number(end - start) / 1e6` then yields a huge positive
 * value that would sail through a bare `> 0` check and poison `max` and p99.
 * The slowest frame anyone has recorded on this project is under 500 ms.
 */
export const GPU_PROBE_MAX_PLAUSIBLE_MS = 5_000;

/** One `long-animation-frame` entry, reduced to the fields this probe reports. */
export interface LongFrameSample {
  duration: number;
  blockingDuration: number;
  forcedStyleAndLayoutDuration: number;
  /**
   * 该长帧里所有 script 条目的 `duration` 之和——**脚本真正占用的时间**。
   *
   * 为什么必须与 `duration` 分开：`duration` 是**这一帧的持续时间**，与帧间隔几乎同义，
   * 拿它去"解释"帧间隔是循环论证（实测 4 视图下 mainThread 总量 9873 ms vs wall 10000 ms，
   * 两者就是同一个数）。只有 `scriptDuration` 才是能拿去和 GPU 时间并列比较的主线程工作量。
   */
  scriptDuration: number;
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

export function frameStats(values: readonly number[]): FrameStats {
  if (!values.length) return { frames: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    frames: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
    mean: total / values.length,
  };
}

/** Whether the renderer will produce real GPU durations. */
export function timestampTrackingEnabled(source: unknown): source is GpuTimestampSource {
  const candidate = source as Partial<GpuTimestampSource> | null | undefined;
  return Boolean(candidate?.backend?.trackTimestamp === true && typeof candidate.resolveTimestampsAsync === "function");
}

/**
 * Samples GPU time, wall-clock frame intervals and CPU submit time together.
 * One asynchronous readback per frame, outside the submit path, so it does not
 * add a GPU stall; frames whose readback is not ready yet are simply reported
 * as wall-only samples and never overwrite an unread resolve buffer.
 */
export class GpuFrameSampler {
  readonly result: GpuProbeResult;

  private readonly source: GpuTimestampSource;
  private readonly scene: { traverse(callback: (object: SplatDrawable) => void): void } | null;
  private stopped = false;
  private pending = false;
  /** Whether any splat drawable was seen; without one the draw check is skipped. */
  private sawSplat = false;
  /** Previous absolute counter values, so per-frame deltas can be reported. */
  private readonly previousCounters: { calls?: number; triangles?: number; points?: number } = {};
  private readonly mainThreadDraft: number[] = [];
  private readonly blockingDraft: number[] = [];
  private forcedLayoutTotal = 0;
  /** 长帧里脚本占用的时长（`scripts[].duration` 之和）。 */
  private readonly scriptDraft: number[] = [];
  private scriptTotal = 0;
  /** Whether the render pool ever reported a recorded query during the run. */
  private sawTimestampQueries = false;

  constructor(source: unknown, label = "gpu-frame", scene?: unknown) {
    const enabled = timestampTrackingEnabled(source);
    this.source = (enabled ? source : {}) as GpuTimestampSource;
    const sceneCandidate = scene as { traverse?: (callback: (object: SplatDrawable) => void) => void } | null | undefined;
    /*
      **必须连着 receiver 调用。** `Object3D.traverse` 读的是 `this.children`，把方法摘下来放进
      一个普通对象再调用，`this` 就是那个包装对象、`children` 是 undefined，于是每帧抛
      `TypeError: Cannot read properties of undefined (reading 'length')`。

      症状极具误导性：墙钟样本是在这一步**之前**压入的，所以报告看起来"跑了 600 帧"，
      而 `views` / `instanceCount` / GPU 样本全是 0，整轮永远 invalid——像是仪器不支持，
      其实是探针自己每帧都在抛。
    */
    this.scene = typeof sceneCandidate?.traverse === "function"
      ? { traverse: (callback) => sceneCandidate.traverse!(callback) }
      : null;
    this.result = {
      label,
      supported: enabled,
      unsupportedReason: enabled ? null : GPU_PROBE_UNSUPPORTED,
      done: false,
      valid: false,
      error: null,
      started: Date.now(),
      elapsedMs: 0,
      gpuSamples: 0,
      renderInfoTimestamp: 0,
      gpuMs: frameStats([]),
      wallMs: frameStats([]),
      cpuSubmitMs: frameStats([]),
      computeSamples: 0,
      computeMs: frameStats([]),
      computeShareOfP50: null,
      gpuShareOfP50: null,
      renderCalls: 0,
      triangles: 0,
      points: 0,
      samples: [],
      computeSamplesMs: [],
      mainThreadFrames: 0,
      mainThreadMs: frameStats([]),
      blockingMs: frameStats([]),
      forcedLayoutMs: 0,
      scriptTotalMs: 0,
      scriptMs: frameStats([]),
      attribution: emptyAttribution(),
      io: emptyIoCounters(),
      visibleViews: 0,
      totalInstanceCount: 0,
      activeSplats: 0,
      invalidation: null,
    };
  }

  /** Records how many splat views were actually drawing this frame. */
  private captureDrawContext(): void {
    if (!this.scene) return;
    let visibleViews = 0;
    let totalInstanceCount = 0;
    let activeSplats = 0;
    let sawSplat = false;
    this.scene.traverse((object) => {
      if (object.activeSplats === undefined && object.geometry?.instanceCount === undefined) return;
      sawSplat = true;
      if (object.visible === false) return;
      visibleViews += 1;
      totalInstanceCount += object.geometry?.instanceCount ?? 0;
      activeSplats = Math.max(activeSplats, object.activeSplats ?? 0);
    });
    if (!sawSplat) return;
    this.sawSplat = true;
    this.result.visibleViews = visibleViews;
    this.result.totalInstanceCount = totalInstanceCount;
    this.result.activeSplats = activeSplats;
  }

  /**
   * Reads one frame's GPU duration. Returns the value pushed, or null when the
   * readback was not ready (which keeps the frame loop free of GPU stalls).
   */
  /**
   * The pool's outstanding query count. Three resets it to 0 when it resolves,
   * so `0` means "no pass has been recorded since the last read" — and in that
   * state `resolveQueriesAsync` hands back `lastValue` from the previous frame
   * rather than failing. Reading it first is the only way to tell a fresh
   * resolve from a replayed one. Returns null when the pool is not observable.
   */
  private queryIndex(type: "render" | "compute"): number | null {
    const index = this.source.backend?.timestampQueryPool?.[type]?.currentQueryIndex;
    return typeof index === "number" ? index : null;
  }

  /**
   * Accepts one resolved duration. Rejects anything non-finite, non-positive or
   * beyond `GPU_PROBE_MAX_PLAUSIBLE_MS`, so a wrapped timestamp counter is
   * dropped instead of being booked as this frame's GPU time.
   */
  private accept(duration: number | undefined): number | null {
    if (typeof duration !== "number" || !Number.isFinite(duration)) return null;
    if (duration <= 0 || duration > GPU_PROBE_MAX_PLAUSIBLE_MS) return null;
    return duration;
  }

  /**
   * Per-frame work counters. Three only resets them from inside its own
   * animation loop, which R3F does not use, so they accumulate for the page's
   * lifetime and a bare read reports a total, not a frame. `render.calls` is
   * additionally never reset at all. Both are handled by diffing, and by
   * preferring the per-frame field when the runtime exposes it.
   */
  private captureCounters(): void {
    const render = this.source.info?.render;
    if (!render) return;
    const step = (previous: number | undefined, value: number | undefined): number => {
      if (typeof value !== "number" || !Number.isFinite(value)) return 0;
      // The first observation is a baseline, not a frame: an accumulated counter
      // already contains everything since page load, so reporting it would
      // overstate one frame by the whole session. A decrease means the counter
      // reset or wrapped, and the new value is itself the delta.
      if (previous === undefined) return 0;
      return value < previous ? value : value - previous;
    };
    const calls = render.frameCalls ?? render.calls;
    this.result.renderCalls = Math.max(this.result.renderCalls, step(this.previousCounters.calls, calls));
    this.result.triangles = Math.max(this.result.triangles, step(this.previousCounters.triangles, render.triangles));
    this.result.points = Math.max(this.result.points, step(this.previousCounters.points, render.points));
    this.previousCounters.calls = calls;
    this.previousCounters.triangles = render.triangles;
    this.previousCounters.points = render.points;
  }

  /**
   * Records one whole-frame main-thread sample. Fed from the browser entry's
   * Long Animation Frames observer: `cpuSubmitMs` only wraps `renderer.render()`,
   * so without this the frame budget cannot be closed.
   */
  recordLongFrame(sample: LongFrameSample): void {
    if (this.stopped) return;
    if (Number.isFinite(sample.duration) && sample.duration > 0) this.mainThreadDraft.push(sample.duration);
    if (Number.isFinite(sample.blockingDuration) && sample.blockingDuration > 0) this.blockingDraft.push(sample.blockingDuration);
    if (Number.isFinite(sample.forcedStyleAndLayoutDuration) && sample.forcedStyleAndLayoutDuration > 0) {
      this.forcedLayoutTotal += sample.forcedStyleAndLayoutDuration;
    }
    /*
      脚本时间单独记，且**只在长帧上**——Long Animation Frame 只在 >50 ms 的帧触发，
      所以这是"长帧里的脚本总量"，不是全部帧的脚本总量。它足以指认限速方：如果它远小于
      同一窗口的 wall，主线程就没被 JS 占满；如果接近 wall，就是 JS 在限速。
    */
    if (Number.isFinite(sample.scriptDuration) && sample.scriptDuration > 0) {
      this.scriptDraft.push(sample.scriptDuration);
      this.scriptTotal += sample.scriptDuration;
    }
  }

  /**
   * Reads one frame's GPU duration from both pools. Returns the render-pool
   * value pushed, or null when the readback was not ready (which keeps the frame
   * loop free of GPU stalls).
   */
  async sample(wallMs: number, cpuSubmitMs = 0): Promise<number | null> {
    if (this.stopped) return null;
    if (wallMs > 0) {
      (this.wallDraft ??= []).push(wallMs);
      this.windowWallMs += wallMs;
    }
    if (cpuSubmitMs > 0) {
      (this.cpuDraft ??= []).push(cpuSubmitMs);
      this.windowCpuMs += cpuSubmitMs;
    }
    this.captureDrawContext();
    this.captureCounters();
    if (this.pending) return null;
    // Nothing has been recorded since the last read, so a resolve now would
    // replay the previous frame's value as if it were this frame's.
    const renderIndex = this.queryIndex("render");
    if (renderIndex === 0) return null;
    if (renderIndex !== null && renderIndex > 0) this.sawTimestampQueries = true;
    /*
      **窗口配对点。** Three 的 `_resolveQueries` 在入口就快照并清空查询池
      （`currentOffsets = new Map(queryOffsets)` → `currentQueryIndex = 0`），所以它这次
      返回的时长覆盖的是"自上次 resolve 以来"这**一段区间**，而不是一个 rAF 间隔。
      在发起 resolve 的同一刻把这段区间的 wall 取走，两侧才是同一分母。

      取走而不是清零到局部变量：`pending` 期间进来的采样会把 wall 累加进**下一个**窗口，
      这正是对的——那段时间的查询也归属下一次 resolve。
    */
    const windowWallMs = this.windowWallMs;
    const windowCpuMs = this.windowCpuMs;
    this.windowWallMs = 0;
    this.windowCpuMs = 0;
    this.pending = true;
    try {
      const rendered = this.accept(await this.source.resolveTimestampsAsync("render"));
      // The sort/projection chain is a compute pass with its own pool; without
      // this read the frame's dominant GPU cost is invisible to `gpuMs`. The
      // pool only exists once a compute pass has been recorded, so its absence
      // means this renderer has no compute work to attribute — not a lost read.
      const hasComputePool = this.source.backend?.timestampQueryPool?.compute != null;
      const computed = hasComputePool
        ? this.accept(await this.source.resolveTimestampsAsync("compute"))
        : null;
      if (this.stopped) return null;
      if (computed !== null) {
        this.result.computeSamplesMs.push(computed);
        this.result.computeSamples += 1;
      }
      if (rendered === null) return null;
      this.result.samples.push(rendered);
      this.result.gpuSamples += 1;
      // 与 `samples` 严格同索引：同一窗口的 wall / cpuSubmit。
      this.pairedWallDraft.push(windowWallMs);
      this.pairedCpuDraft.push(windowCpuMs);
      this.result.renderInfoTimestamp = this.source.info?.render?.timestamp ?? rendered;
      return rendered;
    } catch (cause) {
      this.result.error = cause instanceof Error ? cause.message : String(cause);
      return null;
    } finally {
      this.pending = false;
    }
  }

  private wallDraft: number[] | undefined;
  private cpuDraft: number[] | undefined;
  /** 自上次 resolve 以来累积的 wall / cpuSubmit：配对窗口的两侧。 */
  private windowWallMs = 0;
  private windowCpuMs = 0;
  private readonly pairedWallDraft: number[] = [];
  private readonly pairedCpuDraft: number[] = [];

  stop(reason: string | null = null): GpuProbeResult {
    if (this.stopped) return this.result;
    this.stopped = true;
    this.result.done = true;
    if (reason !== null) {
      this.result.invalidation = { reason, at: Date.now() };
      this.result.error = reason;
    }
    this.result.elapsedMs = Date.now() - this.result.started;
    this.result.gpuMs = frameStats(this.result.samples);
    this.result.computeMs = frameStats(this.result.computeSamplesMs);
    this.result.wallMs = frameStats(this.wallDraft ?? []);
    this.result.cpuSubmitMs = frameStats(this.cpuDraft ?? []);
    this.result.mainThreadFrames = this.mainThreadDraft.length;
    this.result.mainThreadMs = frameStats(this.mainThreadDraft);
    this.result.blockingMs = frameStats(this.blockingDraft);
    this.result.forcedLayoutMs = this.forcedLayoutTotal;
    this.result.scriptTotalMs = this.scriptTotal;
    this.result.scriptMs = frameStats(this.scriptDraft);
    // 帧预算闭合必须在分位数之后算：它用的是整轮总量，回答的是"分位数解释不掉的差额"
    this.result.attribution = buildAttribution({
      wall: this.wallDraft ?? [],
      gpu: this.result.samples,
      compute: this.result.computeSamplesMs,
      cpuSubmit: this.cpuDraft ?? [],
      mainThread: this.mainThreadDraft,
      blocking: this.blockingDraft,
      forcedLayout: this.forcedLayoutTotal,
      // 与 `samples` 同索引，构成同一分母的配对样本
      pairedWall: this.pairedWallDraft,
      pairedCpu: this.pairedCpuDraft,
      script: this.scriptDraft,
    });
    const share = (value: number) => this.result.wallMs.p50 > 0 && value > 0
      ? value / this.result.wallMs.p50
      : null;
    this.result.computeShareOfP50 = share(this.result.computeMs.p50);
    this.result.gpuShareOfP50 = share(this.result.gpuMs.p50 + this.result.computeMs.p50);
    // A run that drew nothing must never be read as "the GPU got fast".
    const drewNothing = this.sawSplat && (this.result.visibleViews === 0 || this.result.totalInstanceCount === 0);
    // The renderer submitted timestamped passes but not one resolved to a
    // non-zero duration: that is this environment's all-zero signature, and it
    // must be reported as such rather than as a suspiciously fast GPU. A pool
    // object that exists at all means tracking is live for this renderer, so
    // "pool present, nothing accepted" is the signature — as is "queries were
    // seen during the run, nothing accepted".
    const poolPresent = this.source.backend?.timestampQueryPool?.render != null;
    const timestampsRecorded = this.sawTimestampQueries
      || (poolPresent ? true : this.result.samples.length > 0);
    const allZero = timestampsRecorded && this.result.samples.length === 0;
    if (reason === null && drewNothing) {
      this.result.invalidation = { reason: "No splat view drew any instance during this run", at: Date.now() };
    } else if (reason === null && allZero) {
      this.result.invalidation = { reason: GPU_PROBE_ALL_ZERO, at: Date.now() };
    }
    this.result.valid = reason === null
      && this.result.supported
      && this.result.error === null
      && this.result.samples.length > 0
      && this.result.invalidation === null;
    return this.result;
  }
}
