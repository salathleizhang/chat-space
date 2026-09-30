import { expect, test } from "bun:test";
import {
  GPU_PROBE_ALL_ZERO,
  GPU_PROBE_UNSUPPORTED,
  GpuFrameSampler,
  buildAttribution,
  formatProbeReport,
  frameStats,
  percentile,
  timestampTrackingEnabled,
} from "./gpuProbe";
import { hookGpuSync, orbitOffset, probeDeviceFrom, startGpuFrameProbe } from "./gpuProbe.browser";

/** Minimal stand-in for a Three renderer with timestamp tracking live. */
function fakeRenderer({
  trackTimestamp = true,
  durations = [5],
  calls = 3,
  computeDurations = null as number[] | null,
  queryIndex = null as number | null,
  counters = null as { calls?: number; triangles?: number; points?: number } | null,
} = {}) {
  let index = 0;
  let computeIndex = 0;
  const resolved: string[] = [];
  const pools: Record<string, unknown> = {};
  // A pool object only exists once three has recorded a pass of that type, so
  // these are opt-in: their absence is the "not observable" case.
  if (queryIndex !== null) pools.render = { currentQueryIndex: queryIndex };
  if (computeDurations !== null) pools.compute = { currentQueryIndex: computeDurations.length };
  // `frameCalls` is three r186's per-frame draw count (it only resets while three
  // owns the animation loop). The fake does not pre-set it, but the field has to
  // exist in the type so a test can install it the way the runtime would.
  const render: {
    timestamp: number;
    calls: number;
    frameCalls?: number;
    triangles: number;
    points: number;
  } = { timestamp: 0, calls, triangles: calls * 2, points: calls * 3, ...(counters ?? {}) };
  const renderer = {
    backend: { trackTimestamp, ...(Object.keys(pools).length ? { timestampQueryPool: pools } : {}) },
    info: { render },
    async resolveTimestampsAsync(type = "render") {
      resolved.push(type);
      if (!trackTimestamp) throw new Error("Timestamp tracking is disabled.");
      if (type === "compute") {
        const list = computeDurations ?? [];
        const value = list[Math.min(computeIndex, list.length - 1)] ?? 0;
        computeIndex += 1;
        return value;
      }
      const value = durations[Math.min(index, durations.length - 1)] ?? 0;
      index += 1;
      // Three mirrors the resolved duration into info.render.timestamp.
      renderer.info.render.timestamp = value;
      return value;
    },
  };
  return { renderer, resolved };
}

test("refuses a renderer that did not enable timestamp tracking", () => {
  const { renderer } = fakeRenderer({ trackTimestamp: false });
  const sampler = new GpuFrameSampler(renderer, "off");
  expect(sampler.result.supported).toBe(false);
  expect(sampler.result.unsupportedReason).toBe(GPU_PROBE_UNSUPPORTED);
  expect(sampler.stop().valid).toBe(false);
});

test("samples resolved GPU durations and mirrors Three's info.render.timestamp", async () => {
  const { renderer } = fakeRenderer({ durations: [5, 7, 9, 11] });
  const sampler = new GpuFrameSampler(renderer, "attached");
  expect(sampler.result.supported).toBe(true);
  for (const wall of [20, 24, 28, 32]) await sampler.sample(wall, 2);
  expect(sampler.result.samples).toEqual([5, 7, 9, 11]);
  expect(sampler.result.gpuSamples).toBe(4);
  const result = sampler.stop();
  expect(result.valid).toBe(true);
  expect(result.gpuMs.p50).toBe(9);
  expect(result.gpuMs.max).toBe(11);
  expect(result.wallMs.p50).toBe(28);
  expect(result.renderInfoTimestamp).toBe(11);
  // GPU is roughly a third of the wall interval: exactly the split rAF hid.
  expect(result.gpuShareOfP50).toBeCloseTo(9 / 28, 5);
  // No compute pool in this fake, so the combined share equals the render share.
  expect(result.computeSamples).toBe(0);
  expect(result.computeShareOfP50).toBeNull();
});

test("one readback is in flight at a time so the frame loop never queues up", async () => {
  const { renderer, resolved } = fakeRenderer({ durations: [4] });
  const sampler = new GpuFrameSampler(renderer);
  const first = sampler.sample(16);
  expect(await sampler.sample(16)).toBeNull();
  expect(await first).toBe(4);
  // The overlapping call short-circuited instead of resolving twice.
  expect(resolved).toHaveLength(1);
  await sampler.sample(16);
  expect(resolved).toHaveLength(2);
  sampler.stop();
});

test("zero or absent durations are never recorded as GPU time", async () => {
  const { renderer } = fakeRenderer({ durations: [0, 0, 6] });
  const sampler = new GpuFrameSampler(renderer);
  await sampler.sample(30);
  await sampler.sample(30);
  await sampler.sample(30);
  const result = sampler.stop();
  expect(result.samples).toEqual([6]);
  // Wall intervals are still counted for every frame.
  expect(result.wallMs.frames).toBe(3);
});

test("a readback failure is surfaced without producing fake GPU time", async () => {
  const { renderer } = fakeRenderer();
  renderer.resolveTimestampsAsync = async () => { throw new Error("device lost"); };
  const sampler = new GpuFrameSampler(renderer);
  await sampler.sample(16);
  const result = sampler.stop();
  expect(result.samples).toEqual([]);
  expect(result.error).toBe("device lost");
  expect(result.valid).toBe(false);
});

test("stop is idempotent and marks cancellation as invalid", async () => {
  const { renderer } = fakeRenderer();
  const sampler = new GpuFrameSampler(renderer);
  await sampler.sample(16);
  const first = sampler.stop("Page became hidden");
  expect(first.valid).toBe(false);
  expect(first.invalidation?.reason).toBe("Page became hidden");
  expect(first.samples).toHaveLength(1);
  expect(sampler.stop("again").invalidation?.reason).toBe("Page became hidden");
});

test("timestampTrackingEnabled requires both the flag and the resolver", () => {
  expect(timestampTrackingEnabled(null)).toBe(false);
  expect(timestampTrackingEnabled({})).toBe(false);
  expect(timestampTrackingEnabled({ backend: { trackTimestamp: true } })).toBe(false);
  expect(timestampTrackingEnabled({ resolveTimestampsAsync: () => Promise.resolve(1) })).toBe(false);
  expect(timestampTrackingEnabled(fakeRenderer().renderer)).toBe(true);
});

test("percentiles and frameStats handle empty and skewed samples", () => {
  expect(percentile([], 0.5)).toBe(0);
  expect(frameStats([])).toEqual({ frames: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
  const stats = frameStats([1, 2, 3, 4, 100]);
  expect(stats.frames).toBe(5);
  expect(stats.p50).toBe(3);
  expect(stats.p95).toBe(100);
  expect(stats.max).toBe(100);
  expect(stats.mean).toBe(22);
});

test("probeDeviceFrom reads the native WebGPU device off the renderer backend", () => {
  expect(probeDeviceFrom(null)).toBeNull();
  expect(probeDeviceFrom({})).toBeNull();
  const device = { tag: "device" };
  expect(probeDeviceFrom({ backend: { device } })).toBe(device);
});

test("browser probe refuses to start when timestamp tracking is off", () => {
  const state = {
    gl: { backend: { trackTimestamp: false }, render: () => {} },
    internal: { interaction: [] as object[] },
  };
  const store = { getState: () => state };
  expect(() => startGpuFrameProbe(store)).toThrow("Timestamp tracking");
  expect(() => startGpuFrameProbe(store, { durationMs: 0 })).toThrow("Invalid GPU probe timing");
});

/**
 * 回归：应用跑 `frameloop="demand"`，探针期间必须临时切到 `"always"`，否则静止场景
 * 一帧都不提交——墙钟会记满 600 帧而 GPU 样本为 0，看起来像仪器不支持。
 */
test("browser probe forces continuous frames and restores the loop afterwards", async () => {
  const { renderer } = fakeRenderer({ durations: [5] });
  const state = {
    // 探针会在运行期间包住 gl.render，所以替身必须有这个方法
    gl: { ...renderer, render: () => {} },
    scene: undefined as unknown,
    internal: { interaction: [] as object[] },
    frameloop: "demand",
    setFrameloop(mode: string) { state.frameloop = mode; },
    invalidated: 0,
    invalidate() { state.invalidated += 1; },
  };
  const store = { getState: () => state };
  const run = startGpuFrameProbe(store, { label: "loop", warmupMs: 0, durationMs: 5 });
  expect(state.frameloop).toBe("always");

  const result = run.stop();
  expect(result.label).toBe("loop");
  expect(state.frameloop).toBe("demand");
  // 还原后要一帧，否则画面会停在探针期间的最后一帧
  expect(state.invalidated).toBeGreaterThan(0);
});

/** Scene stub standing in for the four GSL view renderers. */
function fakeScene(views: Array<{ visible?: boolean; activeSplats?: number; instanceCount?: number }>) {
  return {
    traverse(callback: (object: { visible?: boolean; activeSplats?: number; geometry?: { instanceCount?: number } }) => void) {
      for (const view of views) {
        callback({ visible: view.visible ?? true, activeSplats: view.activeSplats, geometry: { instanceCount: view.instanceCount } });
      }
    },
  };
}

test("records splat draw context so GPU time can be read against what was drawn", async () => {
  const { renderer } = fakeRenderer({ durations: [8] });
  const scene = fakeScene([
    { activeSplats: 1_920_000, instanceCount: 15_000 },
    { activeSplats: 1_920_000, instanceCount: 15_000 },
    { visible: false, activeSplats: 1_920_000, instanceCount: 15_000 },
    { activeSplats: 1_920_000, instanceCount: 0 },
  ]);
  const sampler = new GpuFrameSampler(renderer, "context", scene);
  await sampler.sample(16);
  const result = sampler.stop();
  expect(result.visibleViews).toBe(3);
  expect(result.totalInstanceCount).toBe(30_000);
  expect(result.activeSplats).toBe(1_920_000);
  expect(result.valid).toBe(true);
});

test("a run where no splat view drew an instance is invalidated, not reported fast", async () => {
  const { renderer } = fakeRenderer({ durations: [3] });
  // The recorded "0 drawing instances" failure: active points exist, nothing draws.
  const scene = fakeScene([
    { activeSplats: 1_920_000, instanceCount: 0 },
    { visible: false, activeSplats: 1_920_000, instanceCount: 0 },
  ]);
  const sampler = new GpuFrameSampler(renderer, "zero-draw", scene);
  await sampler.sample(16);
  const result = sampler.stop();
  // The 3ms GPU time is real, but it is not a valid measurement of the scene.
  expect(result.gpuSamples).toBe(1);
  expect(result.valid).toBe(false);
  expect(result.invalidation?.reason).toContain("drew any instance");
});

test("scene-less probes keep working and are not invalidated by the draw check", async () => {
  const { renderer } = fakeRenderer({ durations: [5] });
  const sampler = new GpuFrameSampler(renderer, "no-scene");
  await sampler.sample(16);
  const result = sampler.stop();
  expect(result.visibleViews).toBe(0);
  expect(result.valid).toBe(true);
});

test("a device with no discoverable feature set still arms and reports zero as invalid", async () => {
  const renderer = {
    backend: { trackTimestamp: true },
    info: { render: { timestamp: 0, calls: 1, triangles: 0, points: 0 } },
    async resolveTimestampsAsync() { return 0; },
  };
  const sampler = new GpuFrameSampler(renderer, "zero-only");
  expect(sampler.result.supported).toBe(true);
  await sampler.sample(16);
  await sampler.sample(16);
  const result = sampler.stop();
  expect(result.gpuSamples).toBe(0);
  expect(result.valid).toBe(false);
});

test("an all-zero sampled run is invalidated with an explicit reason", async () => {
  const { renderer } = fakeRenderer({ durations: [0] });
  // Force a zero through so the all-zero signature can be observed.
  const sampler = new GpuFrameSampler(renderer, "all-zero");
  const original = renderer.resolveTimestampsAsync;
  renderer.resolveTimestampsAsync = async () => { void original; return 0; };
  await sampler.sample(16);
  const result = sampler.stop();
  expect(result.valid).toBe(false);
  expect(result.samples).toEqual([]);
  expect(GPU_PROBE_ALL_ZERO).toContain("0 ms");
});

test("samples the compute pool separately so the splat sort is not invisible", async () => {
  // GSL submits projection and the radix sort with renderer.compute(), and three
  // writes those timestamps into a different pool than the render passes.
  const { renderer, resolved } = fakeRenderer({ durations: [4], computeDurations: [80] });
  const sampler = new GpuFrameSampler(renderer, "compute-pool");
  await sampler.sample(100);
  const result = sampler.stop();
  expect(resolved).toEqual(["render", "compute"]);
  expect(result.computeSamples).toBe(1);
  expect(result.computeMs.p50).toBe(80);
  expect(result.computeShareOfP50).toBeCloseTo(0.8, 5);
  // The render pool alone says 4 ms of a 100 ms frame; the frame is really 84 ms.
  expect(result.gpuMs.p50).toBe(4);
  expect(result.gpuShareOfP50).toBeCloseTo(0.84, 5);
});

test("a resolve with no new queries is skipped instead of replaying the last value", async () => {
  // currentQueryIndex 0 means "nothing recorded since the last read", which is
  // exactly when three hands back the previous frame's value.
  const { renderer, resolved } = fakeRenderer({ queryIndex: 0 });
  const sampler = new GpuFrameSampler(renderer, "stale");
  expect(await sampler.sample(33)).toBeNull();
  expect(resolved).toEqual([]);
  expect(sampler.result.samples).toEqual([]);
  // Wall intervals are finalized by stop(), same as the sibling test above: the
  // frame is still counted even though the GPU read was skipped.
  expect(sampler.stop().wallMs.frames).toBe(1);
});

test("an implausibly large duration is dropped rather than booked as frame time", async () => {
  // A reset timestamp counter surfaces as a huge positive delta, not a negative one.
  const { renderer } = fakeRenderer({ durations: [1e9, 6] });
  const sampler = new GpuFrameSampler(renderer, "wrapped");
  await sampler.sample(16);
  await sampler.sample(16);
  const result = sampler.stop();
  expect(result.samples).toEqual([6]);
  expect(result.gpuMs.max).toBe(6);
});

test("per-frame counters are reported as deltas, not lifetime totals", async () => {
  // render.calls is a lifetime monotonic id in three r186 (Info.reset() never
  // clears it), and triangles/points/frameCalls only reset while three owns the
  // animation loop, which R3F does not use. None of them can be read absolutely.
  const { renderer } = fakeRenderer({ durations: [1], calls: 999 });
  renderer.info.render.frameCalls = 40;
  renderer.info.render.triangles = 80;
  const sampler = new GpuFrameSampler(renderer, "counters");
  await sampler.sample(16);
  // The first observation is a baseline, never reported as one frame.
  expect(sampler.result.renderCalls).toBe(0);
  expect(sampler.result.triangles).toBe(0);
  renderer.info.render.frameCalls = 46;
  renderer.info.render.triangles = 12_080;
  await sampler.sample(16);
  expect(sampler.result.renderCalls).toBe(6);
  expect(sampler.result.triangles).toBe(12_000);
  // frameCalls wins over calls: if the lifetime id leaked in, this would jump.
  await sampler.sample(16);
  expect(sampler.result.renderCalls).toBe(6);
  expect(sampler.result.triangles).toBe(12_000);
  sampler.stop();
});

test("a mid-run readback failure invalidates a run that already has samples", async () => {
  const { renderer } = fakeRenderer({ durations: [5] });
  const sampler = new GpuFrameSampler(renderer, "mid-run-error");
  await sampler.sample(16);
  expect(sampler.result.samples).toHaveLength(1);
  renderer.resolveTimestampsAsync = async () => { throw new Error("device lost"); };
  await sampler.sample(16);
  const result = sampler.stop();
  // The earlier 5 ms is real, but the run as a whole is not a valid measurement.
  expect(result.samples).toHaveLength(1);
  expect(result.error).toBe("device lost");
  expect(result.valid).toBe(false);
});

test("whole-frame main-thread work is reported separately from render submit time", () => {
  const { renderer } = fakeRenderer({ durations: [2] });
  const sampler = new GpuFrameSampler(renderer, "main-thread");
  sampler.recordLongFrame({ duration: 120, blockingDuration: 90, forcedStyleAndLayoutDuration: 30, scriptDuration: 70 });
  sampler.recordLongFrame({ duration: 60, blockingDuration: 10, forcedStyleAndLayoutDuration: 5, scriptDuration: 25 });
  sampler.recordLongFrame({ duration: 80, blockingDuration: 20, forcedStyleAndLayoutDuration: 0, scriptDuration: 5 });
  const result = sampler.stop();
  expect(result.mainThreadFrames).toBe(3);
  expect(result.mainThreadMs.p50).toBe(80);
  expect(result.mainThreadMs.max).toBe(120);
  expect(result.blockingMs.max).toBe(90);
  expect(result.forcedLayoutMs).toBe(35);
  expect(result.scriptTotalMs).toBe(100);
  expect(result.scriptMs.p50).toBe(25);
  // This is CPU main-thread time and must never be counted as a GPU sample.
  expect(result.gpuSamples).toBe(0);
  expect(result.gpuMs.frames).toBe(0);
});

/**
 * 脚本时间与帧持续时间的区别——这是"谁来限速"的唯一判据。
 *
 * Long Animation Frame 的 `duration` 是**该帧的持续时间**，与帧间隔几乎同义。实测 4 视图
 * 下 mainThread 总量 9873 ms vs wall 10000 ms，两者就是同一个数，拿它解释帧间隔是循环论证。
 * `scripts[].duration` 之和才是能拿去和 GPU / wall 并列比较的主线程工作量。
 */
test("脚本时间单独采集：shareOfWall 才是主线程是否限速的判据", async () => {
  const { renderer } = fakeRenderer({ durations: [10] });
  const sampler = new GpuFrameSampler(renderer, "script-time");
  await sampler.sample(1000, 3);
  sampler.recordLongFrame({ duration: 400, blockingDuration: 0, forcedStyleAndLayoutDuration: 0, scriptDuration: 120 });
  sampler.recordLongFrame({ duration: 300, blockingDuration: 0, forcedStyleAndLayoutDuration: 0, scriptDuration: 80 });
  const result = sampler.stop();

  expect(result.scriptTotalMs).toBe(200);
  expect(result.scriptMs.p50).toBe(120);
  // 帧持续时间（400 ms）远大于脚本时间（120 ms）：不能拿前者指认限速方
  expect(result.mainThreadMs.max).toBe(400);
  expect(result.scriptMs.max).toBe(120);
  expect(result.attribution.scriptTotalMs).toBe(200);
  expect(result.attribution.scriptMeanMs).toBe(100);
  expect(result.attribution.scriptShareOfWall).toBeCloseTo(0.2, 5);

  const text = formatProbeReport(result);
  expect(text).toContain("scripts(ms): total=200.0");
  expect(text).toContain("shareOfWall=20%");
});

/**
 * 帧预算闭合：把"3 视图 3183 ms 帧间隔 vs 362 ms 已计时 GPU"这类缺口变成一个可读的数字。
 * 这些是纯算术，不依赖浏览器——真实数字要靠 `?gpuTimestamps=1` 的可见窗口跑出来。
 */
test("attribution: 主线程与 GPU 都没解释掉的时间就是缺口", () => {
  const attribution = buildAttribution({
    wall: [3000, 183],
    gpu: [362],
    compute: [],
    cpuSubmit: [40],
    mainThread: [600],
    blocking: [200],
    forcedLayout: 25,
  });
  expect(attribution.wallFrames).toBe(2);
  expect(attribution.gpuFrames).toBe(1);         // 只有一帧解析出 GPU 时长
  expect(attribution.wallTotalMs).toBe(3183);
  expect(attribution.gpuTotalMs).toBe(362);
  expect(attribution.mainThreadTotalMs).toBe(600);
  expect(attribution.blockingTotalMs).toBe(200);
  expect(attribution.forcedLayoutTotalMs).toBe(25);
  // 3183 − max(362, 600) —— 缺口在这里
  expect(attribution.unexplainedMs).toBe(2583);
});

test("attribution: 主线程与 GPU 并行，所以按较大的那一侧扣，不相加", () => {
  // GPU 800 已经盖住主线程 300，墙钟 900：只剩 100 没解释
  const covered = buildAttribution({
    wall: [900], gpu: [800], compute: [], cpuSubmit: [],
    mainThread: [300], blocking: [], forcedLayout: 0,
  });
  expect(covered.unexplainedMs).toBe(100);

  // 两侧加起来超过墙钟是正常的（并行），此时不该报出正缺口
  const overlapping = buildAttribution({
    wall: [500], gpu: [400], compute: [150], cpuSubmit: [],
    mainThread: [100], blocking: [], forcedLayout: 0,
  });
  expect(overlapping.unexplainedMs).toBe(-50);
});

test("attribution: compute 池算进 GPU 侧；空轮次全零", () => {
  const withCompute = buildAttribution({
    wall: [100], gpu: [10], compute: [70], cpuSubmit: [],
    mainThread: [], blocking: [], forcedLayout: 0,
  });
  expect(withCompute.computeFrames).toBe(1);
  expect(withCompute.unexplainedMs).toBe(20);

  const empty = new GpuFrameSampler(fakeRenderer().renderer, "empty").stop();
  expect(empty.attribution).toEqual({
    wallFrames: 0, gpuFrames: 0, computeFrames: 0, mainThreadFrames: 0,
    wallTotalMs: 0, gpuTotalMs: 0, computeTotalMs: 0, cpuSubmitTotalMs: 0,
    mainThreadTotalMs: 0, blockingTotalMs: 0, forcedLayoutTotalMs: 0,
    wallMeanMs: 0, gpuMeanMs: 0, mainThreadMeanMs: 0, unexplainedMs: 0,
    pairedWindows: 0, pairedWallTotalMs: 0, pairedGpuTotalMs: 0, pairedComputeTotalMs: 0, pairedComputeMeanMs: 0,
    pairedWallMeanMs: 0, pairedGpuMeanMs: 0, gpuUtilization: null, pairedCpuTotalMs: 0,
    scriptTotalMs: 0, scriptMeanMs: 0, scriptShareOfWall: null,
  });
});

test("整轮跑完后 attribution 被填上，覆盖帧数如实反映解析情况", async () => {
  const { renderer } = fakeRenderer({ durations: [12, 8] });
  const sampler = new GpuFrameSampler(renderer, "attribution");
  await sampler.sample(33, 4);
  await sampler.sample(33, 6);
  sampler.recordLongFrame({ duration: 120, blockingDuration: 90, forcedStyleAndLayoutDuration: 30, scriptDuration: 70 });
  const result = sampler.stop();
  expect(result.attribution.wallFrames).toBe(2);
  expect(result.attribution.gpuFrames).toBe(2);
  expect(result.attribution.wallTotalMs).toBe(66);
  expect(result.attribution.gpuTotalMs).toBe(20);
  expect(result.attribution.cpuSubmitTotalMs).toBe(10);
  expect(result.attribution.mainThreadFrames).toBe(1);
  expect(result.attribution.unexplainedMs).toBe(66 - Math.max(20, 120));
});

test("报告：缺口、覆盖告警与无效轮次都写在可粘贴的文本里", async () => {
  const { renderer } = fakeRenderer({ durations: [12] });
  const sampler = new GpuFrameSampler(renderer, "report");
  await sampler.sample(3000, 40);
  sampler.recordLongFrame({ duration: 600, blockingDuration: 200, forcedStyleAndLayoutDuration: 25, scriptDuration: 180 });
  const text = formatProbeReport(sampler.stop());

  expect(text).toContain("[gpu-probe] report");
  expect(text).toContain("gpuCoverage=1/1");
  expect(text).toContain("unexplained=2400.0ms");
  expect(text).toContain("forcedLayout=25.0");
  expect(text).toContain("draw: views=");
  // 覆盖只有 1/1，不该出现"覆盖不足"的告警
  expect(text).not.toContain("fewer than half the frames");
});

test("报告：GPU 覆盖不足与无效轮次各有一条告警", async () => {
  // queryIndex 0 = 这一帧没有记录任何 pass，sample() 会跳过读取但仍计入墙钟
  const { renderer } = fakeRenderer({ queryIndex: 0 });
  const sampler = new GpuFrameSampler(renderer, "sparse");
  for (let frame = 0; frame < 4; frame++) await sampler.sample(10);
  const text = formatProbeReport(sampler.stop());
  expect(text).toContain("gpuCoverage=0/4");
  // 覆盖不足时提示"比配对行，别比混合分母的均值"（而不是断言仪器坏了——帧慢时覆盖率天然低）
  expect(text).toContain("Compare the paired line, not the mixed-denominator means");
  expect(text).toContain("means(ms):");
  // 什么都没解析出来 → 这一轮不成立，必须写明
  expect(text).toContain("not a valid measurement");
});

/**
 * 回归：视口快照的遍历必须带着 receiver 调用。
 *
 * 曾经的写法是把 `scene.traverse` 摘下来塞进 `{ traverse }`。`Object3D.traverse` 读的是
 * `this.children`，于是每帧抛 TypeError——症状极具误导性：墙钟样本在抛错之前就压进去了，
 * 报告看起来"跑了 600 帧"，而 views / instanceCount / GPU 样本全是 0，整轮永远 invalid，
 * 像是仪器不支持，其实是探针自己每帧都在抛。
 */
test("视口快照：traverse 依赖 receiver，摘下来调用会每帧抛错", async () => {
  // 与 Object3D.traverse 同形状：读 this.children，且第一个回调参数是 this
  const view = {
    children: [
      { activeSplats: 1_920_000, geometry: { instanceCount: 15_000 }, visible: true },
      { activeSplats: 1_920_000, geometry: { instanceCount: 15_000 }, visible: false },
    ],
    traverse(this: { children: unknown[] } | void, callback: (object: unknown) => void) {
      callback(this);
      for (const child of (this as { children: unknown[] }).children) callback(child);
    },
  };
  const { renderer } = fakeRenderer({ durations: [12] });
  const sampler = new GpuFrameSampler(renderer, "receiver", view);
  await sampler.sample(16);           // 今天会在这里抛；修好之后正常记录
  const result = sampler.stop();
  expect(result.visibleViews).toBe(1);          // 只有 visible 的那个算
  expect(result.totalInstanceCount).toBe(15_000);
  expect(result.activeSplats).toBe(1_920_000);
});

test("视口快照：没有 scene 时不影响其余测量", async () => {
  const { renderer } = fakeRenderer({ durations: [12] });
  const sampler = new GpuFrameSampler(renderer, "no-scene");
  await sampler.sample(16);
  const result = sampler.stop();
  expect(result.attribution.wallFrames).toBe(1);
  expect(result.visibleViews).toBe(0);
});

/**
 * 窗口配对：把 GPU 与 wall 放到同一分母。
 *
 * 为什么需要：Three 的查询池在 `_resolveQueries` **入口**就快照并清空
 * （`currentOffsets = new Map(queryOffsets)` → `currentQueryIndex = 0`），所以一次
 * `resolveTimestampsAsync` 返回的是**自上次 resolve 以来**的总和，中间可以隔着好几个
 * rAF 采样。旧写法把这一次总和配上一个 rAF 间隔，就是拿两个分母做差——"3 视图 362 ms
 * 解释不了 3183 ms"那个缺口正出自这里（AGENTS.md 第六节）。
 */
test("配对：一次 resolve 覆盖一段区间，wall 取自同一区间而不是一个 rAF 间隔", async () => {
  let release: ((value: number) => void) | undefined;
  const renderer = {
    backend: { trackTimestamp: true },
    info: { render: { timestamp: 0, calls: 0 } },
    resolveTimestampsAsync: () => new Promise<number>((resolve) => { release = resolve; }),
  };
  const sampler = new GpuFrameSampler(renderer, "window");
  const inFlight = sampler.sample(30, 2);   // 打开窗口：此刻快照到的 wall 是 30 ms
  await sampler.sample(20, 1);              // 读回未完成，这两段 wall 归入**下一个**窗口
  await sampler.sample(20, 1);
  release!(24);                             // 这一次 resolve 的 GPU 时长
  expect(await inFlight).toBe(24);

  const result = sampler.stop();
  expect(result.attribution.pairedWindows).toBe(1);
  expect(result.attribution.pairedWallTotalMs).toBe(30);
  expect(result.attribution.pairedGpuTotalMs).toBe(24);
  expect(result.attribution.pairedCpuTotalMs).toBe(2);
  // 同一分母，可以直接比：这段窗口里 GPU 占了 80%
  expect(result.attribution.gpuUtilization).toBeCloseTo(0.8, 5);
  // 混合分母的总量仍然覆盖全部三帧——它和配对行不是一回事，这正是旧口径的问题
  expect(result.attribution.wallTotalMs).toBe(70);
  expect(result.attribution.wallFrames).toBe(3);
  expect(result.attribution.gpuFrames).toBe(1);
});

test("配对：只在两侧一一对应时给出比率，缺配对数据不虚构分母", () => {
  const paired = buildAttribution({
    wall: [30, 40], gpu: [24, 10], compute: [], cpuSubmit: [2, 2],
    mainThread: [], blocking: [], forcedLayout: 0,
    pairedWall: [30, 40], pairedCpu: [2, 2],
  });
  expect(paired.pairedWindows).toBe(2);
  expect(paired.pairedWallTotalMs).toBe(70);
  expect(paired.pairedGpuTotalMs).toBe(34);
  expect(paired.pairedWallMeanMs).toBe(35);
  expect(paired.pairedGpuMeanMs).toBe(17);
  expect(paired.gpuUtilization).toBeCloseTo(34 / 70, 5);

  // 没有配对数据时（旧调用方）不产出比率，而不是拿 wall 总量去除
  const unpaired = buildAttribution({
    wall: [30, 40], gpu: [24, 10], compute: [], cpuSubmit: [],
    mainThread: [], blocking: [], forcedLayout: 0,
  });
  expect(unpaired.pairedWindows).toBe(0);
  expect(unpaired.pairedWallTotalMs).toBe(0);
  expect(unpaired.gpuUtilization).toBeNull();
});

test("配对：两侧长度错位时拒绝产出统计，而不是给一个看似合理的比率", () => {
  const attribution = buildAttribution({
    wall: [10, 20], gpu: [5, 7], compute: [], cpuSubmit: [],
    mainThread: [], blocking: [], forcedLayout: 0,
    // gpu 有两个样本，配对的 wall 只有一个：下标不再一一对应
    pairedWall: [10], pairedCpu: [1],
  });
  expect(attribution.pairedWindows).toBe(0);
  expect(attribution.pairedWallTotalMs).toBe(0);
  expect(attribution.pairedGpuTotalMs).toBe(0);
  expect(attribution.gpuUtilization).toBeNull();
});

test("报告：配对行与利用率写进可粘贴文本，并点名别用混合分母", async () => {
  const { renderer } = fakeRenderer({ durations: [24] });
  const sampler = new GpuFrameSampler(renderer, "paired-report");
  await sampler.sample(30, 2);
  const text = formatProbeReport(sampler.stop());
  expect(text).toContain("paired(ms): windows=1 wall=30.0 gpu=24.0 cpuSubmit=2.0");
  expect(text).toContain("perWindow wall=30.0 gpu=24.0");
  expect(text).toContain("gpuUtilization=80%");
  expect(text).toContain("混合分母");
});


/**
 * 回归：`motion` 必须能改变**正交**窗格的视角。
 *
 * 旧实现只旋转透视相机，而 4 视图布局里三个窗格是正交的——GSL 排序是脏标记驱动的，
 * 静止的正交窗格很可能根本不重排，于是"每个视图各自排序"这条路径根本没被压到。
 */
test("orbitOffset：俯视图（forward ∥ up）也能改变视角，不会原地打转", () => {
  // 相机在 +Y 上方俯视原点，up 取 (0,0,1)——俯视图的常见取法
  const position = { x: 0, y: 20, z: 0 };
  const target = { x: 0, y: 0, z: 0 };
  const up = { x: 0, y: 0, z: 1 };
  const moved = orbitOffset(position, target, up, 0.3);

  // 视角真的变了：位置不再正对下方
  expect(Math.hypot(moved.x, moved.z)).toBeGreaterThan(1);
  // 而且它是一次"轨道"运动：到目标的距离不变
  const before = Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z);
  const after = Math.hypot(moved.x - target.x, moved.y - target.y, moved.z - target.z);
  expect(after).toBeCloseTo(before, 6);
});

test("orbitOffset：forward 与 up 完全平行时退回世界 X，不做无效旋转", () => {
  // up=(0,1,0) 且相机在正上方 → forward=(0,-1,0) 与 up 反平行
  const moved = orbitOffset({ x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.4);
  expect(Math.hypot(moved.x, moved.z)).toBeGreaterThan(1);
  expect(moved.y).toBeCloseTo(10 * Math.cos(0.4), 6);
});

test("motion：正交窗格（没有 controls）也会被移动并还原", async () => {
  const { renderer } = fakeRenderer({ durations: [5] });
  const makeCamera = (z: number, perspective: boolean) => ({
    isPerspectiveCamera: perspective,
    position: { x: 0, y: 10, z, clone() { return { ...this }; }, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }); } },
    up: { x: 0, y: 0, z: 1, clone() { return { ...this }; }, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }); } },
    lookAt() {},
  });
  const perspective = makeCamera(20, true);
  const ortho = makeCamera(20, false);
  const state = {
    gl: { ...renderer, render: () => {} },
    scene: undefined as unknown,
    internal: {
      interaction: [
        { __r3f: { root: { getState: () => ({ camera: perspective, controls: { enabled: true, object: perspective, target: { x: 0, y: 0, z: 0, clone() { return { ...this }; }, set() {} } } }) } } },
        // 正交窗格：**没有 controls**
        { __r3f: { root: { getState: () => ({ camera: ortho, controls: undefined }) } } },
      ],
    },
    frameloop: "demand",
    setFrameloop(mode: string) { state.frameloop = mode; },
    invalidate() {},
  };
  const run = startGpuFrameProbe({ getState: () => state }, { label: "motion", motion: true, warmupMs: 0, durationMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(ortho.position.z).not.toBe(20);          // 正交窗格确实动了
  run.stop();
  expect(ortho.position.z).toBe(20);              // 收尾时放回原位
  expect(ortho.up.z).toBe(1);
});


/** io 计数：present / submit / render 三类各自计数、**只在采样窗口内**计数，且收尾必须把钩子摘干净。 */
test("io 计数：present/submit/render 只在采样窗口内计数，收尾还原钩子", async () => {
  const { renderer } = fakeRenderer({ durations: [5] });
  const originalGetCurrentTexture = () => ({});
  const originalSubmit = () => {};
  const context = { getCurrentTexture: originalGetCurrentTexture };
  const queue = { submit: originalSubmit };
  const gl = {
    ...renderer,
    render: () => {},
    domElement: { getContext: (id: string) => (id === "webgpu" ? context : null) },
    backend: { trackTimestamp: true, device: { queue } },
  };
  const state = {
    gl,
    scene: undefined as unknown,
    internal: { interaction: [] as object[] },
    frameloop: "demand",
    setFrameloop(mode: string) { state.frameloop = mode; },
    invalidate() {},
  };
  const run = startGpuFrameProbe({ getState: () => state }, { label: "io", warmupMs: 0, durationMs: 200 });

  /*
    **预热期（第一次 rAF 之前）的调用不得计数。** 这三个数最终都除以 `wallFrames`，而
    `wallFrames` 只覆盖采样窗口；分子若把窗口外也算进去，"每帧"数就会虚高。实测踩过：
    同一配置两次运行给出 `renders=9.85` 与 `renders=15.76`，看着像结构性差异，其实只是
    预热窗口长短不同。所以下面这三次调用预期**全部被丢掉**。
  */
  context.getCurrentTexture();
  queue.submit();
  gl.render();
  await new Promise((resolve) => setTimeout(resolve, 30)); // 让 rAF 跑起来，采样窗口开始

  // 窗口内：呈现两次、提交一次、渲染两次（两次呈现间隔 30 ms）
  context.getCurrentTexture();
  await new Promise((resolve) => setTimeout(resolve, 30));
  context.getCurrentTexture();
  queue.submit();
  gl.render();
  gl.render();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const result = run.stop();
  expect(result.io.presents).toBe(2); // 不是 3：窗口外那次没计
  expect(result.io.submits).toBe(1); // 不是 2
  expect(result.io.renders).toBe(2); // 不是 3
  // 相邻呈现间隔被记下来：两次呈现相隔 ~30 ms
  expect(result.io.presentGapMs.frames).toBe(1);
  expect(result.io.presentGapMs.p50).toBeGreaterThan(20);
  // 每帧摊到的次数就是"总数 ÷ rAF 帧数"，恒等式必须成立
  expect(result.attribution.wallFrames).toBeGreaterThan(0);
  expect(result.io.presentsPerWallFrame).toBeCloseTo(result.io.presents / result.attribution.wallFrames, 9);
  // 钩子摘干净：探针结束后画布与队列要回到原样
  expect(context.getCurrentTexture).toBe(originalGetCurrentTexture);
  expect(queue.submit).toBe(originalSubmit);
});


/**
 * 回归：`gpuUtilization` 必须**同时**包含 render 与 compute 两个池。
 *
 * splat 的投影/排序跑在 compute 池里，Three 把它的时间戳写进另一个查询池。
 * 只算 render 会让这个指标系统性偏低——而它正是用来判断"GPU 是否饱和"的。
 */
test("gpuUtilization 含 compute 池；两侧样本数不一致时不硬拼", () => {
  const paired = buildAttribution({
    wall: [100], gpu: [20], compute: [30], cpuSubmit: [], mainThread: [], blocking: [], forcedLayout: 0,
    pairedWall: [100],
  });
  expect(paired.pairedGpuTotalMs).toBe(20);          // render 池单独可读
  expect(paired.pairedComputeTotalMs).toBe(30);      // compute 池单独可读
  expect(paired.gpuUtilization).toBeCloseTo(0.5, 9); // (20+30)/100

  // 数量不齐 = 这一轮配对不成立 → 宁可只报 render，也不拼一个假总量
  const mismatched = buildAttribution({
    wall: [100], gpu: [20], compute: [10, 10], cpuSubmit: [], mainThread: [], blocking: [], forcedLayout: 0,
    pairedWall: [100],
  });
  expect(mismatched.pairedComputeTotalMs).toBe(0);
  expect(mismatched.gpuUtilization).toBeCloseTo(0.2, 9);
});


/**
 * GPU→CPU 同步计数：`mapAsync` / `onSubmittedWorkDone` 的调用次数与等待时长。
 * 这两类 await 既不算 LAF 脚本时间、也不算 GPU 时间，是"帧与帧之间在等什么"的第一嫌疑人。
 */
test("hookGpuSync：计数并计时，且能完整还原原型", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  // 替身自己在内部等 15 ms：要测的是"调用到 resolve 之间等了多久"
  const originalMapAsync = async function (this: unknown, ..._args: unknown[]) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return "mapped";
  };
  const originalOnSubmitted = async function (this: unknown, ..._args: unknown[]) { return undefined; };
  globals.GPUBuffer = class { mapAsync(...args: never[]) { return originalMapAsync.apply(this, args); } };
  globals.GPUQueue = class { onSubmittedWorkDone(...args: never[]) { return originalOnSubmitted.apply(this, args); } };
  const bufferClass = globals.GPUBuffer as { prototype: { mapAsync: unknown } };
  const queueClass = globals.GPUQueue as { prototype: { onSubmittedWorkDone: unknown } };
  // 挂钩前原型上的那两个函数——还原后必须回到它们（是包装函数，不是内部原函数）
  const wrapperMapAsync = bufferClass.prototype.mapAsync;
  const wrapperOnSubmitted = queueClass.prototype.onSubmittedWorkDone;

  try {
    const hook = hookGpuSync();
    const buffer = new (globals.GPUBuffer as new () => { mapAsync(): Promise<unknown> })();
    const queue = new (globals.GPUQueue as new () => { onSubmittedWorkDone(): Promise<unknown> })();

    await buffer.mapAsync();                      // 内部等 15 ms
    await buffer.mapAsync();
    await queue.onSubmittedWorkDone();

    expect(hook.calls.mapAsync).toHaveLength(2);
    // 调用方指纹：至少记下一条，且不是探针自己
    expect(hook.calls.mapAsyncCallers.length).toBeGreaterThan(0);
    expect(hook.calls.mapAsyncCallers[0]).not.toContain("gpuProbe.browser");
    expect(hook.calls.onSubmitted).toHaveLength(1);
    expect(hook.calls.mapAsync[0]!).toBeGreaterThan(10);   // 计时覆盖了那 15 ms

    hook.restore();
    expect(bufferClass.prototype.mapAsync).toBe(wrapperMapAsync);
    expect(queueClass.prototype.onSubmittedWorkDone).toBe(wrapperOnSubmitted);
  } finally {
    delete globals.GPUBuffer;
    delete globals.GPUQueue;
  }
});
