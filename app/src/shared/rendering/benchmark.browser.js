/** Dev-only, read-only scene benchmark. Also injectable into the fixed WebGL
 * baseline: no app imports, uploads, project edits or private GPU timestamps.
 * Frame intervals are browser rAF intervals; submitMs is CPU render time, NOT GPU time.
 */
const activeBenchmarks = new WeakSet();

export function startRenderBenchmark(store, options = {}) {
  const durationMs = options.durationMs ?? 30000;
  const warmupMs = options.warmupMs ?? 3000;
  const repetitions = options.repetitions ?? 3;
  /** "continuous" keeps the fixed camera-rotation protocol. "alternate" splits
   * each run into a rotating phase and a settled phase so the two can be
   * compared separately (motion degradation vs steady-state cost). */
  const motion = options.motion ?? "continuous";
  const settleRatio = options.settleRatio ?? 0.5;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(warmupMs) || warmupMs < 0 ||
    !Number.isSafeInteger(repetitions) || repetitions <= 0) throw new Error("Invalid benchmark timing options.");
  if (motion !== "continuous" && motion !== "alternate") throw new Error("Invalid benchmark motion option.");
  if (!Number.isFinite(settleRatio) || settleRatio < 0 || settleRatio > 1) throw new Error("Invalid benchmark settle ratio.");
  if (document.hidden) throw new Error("Benchmark requires a visible page.");
  if (!document.hasFocus()) throw new Error("Benchmark requires a focused window.");
  const state = store.getState();
  const controls = [...new Set(state.internal.interaction.map((object) => object.__r3f?.root.getState().controls).filter(Boolean))];
  if (!controls.length) throw new Error("Benchmark found no active view cameras.");
  const snapshots = controls.map((control) => ({ control, enabled: control.enabled,
    position: control.object.position.clone(), quaternion: control.object.quaternion.clone(),
    up: control.object.up.clone(), target: control.target.clone() }));
  const gl = state.gl;
  if (activeBenchmarks.has(gl)) throw new Error("A benchmark is already running on this renderer.");
  const dimensions = () => ({ dpr: gl.getPixelRatio(), width: gl.domElement.width, height: gl.domElement.height,
    cssWidth: gl.domElement.clientWidth, cssHeight: gl.domElement.clientHeight });
  const initialDimensions = dimensions();
  const signature = JSON.stringify(initialDimensions);
  const cameraObjects = controls.map((control) => control.object);
  activeBenchmarks.add(gl);
  const originalRender = gl.render;
  let cpuMs = 0, raf = 0, stopped = false;
  const result = { label: options.label ?? "unspecified", done: false, error: /** @type {string | null} */ (null),
    valid: false, ...initialDimensions, cameras: controls.map((control) => ({ type: control.object.type,
      position: control.object.position.toArray(), target: control.target.toArray(),
      projection: control.object.projectionMatrix.toArray() })),
    runs: /** @type {Array<{frames: number, p50: number, p95: number, p99: number, over50ms: number, cpuSubmitP95: number, elapsedMs: number, dimensions: ReturnType<typeof dimensions>, memory: object, renderCalls: number, triangles: number, points: number, motion: object, settle: object | null}>} */ ([]),
    started: Date.now(), invalidation: /** @type {{reason: string, at: number, dimensions: ReturnType<typeof dimensions>} | null} */ (null) };
  const measuredRender = function (...args) {
    const start = performance.now();
    try { return originalRender.apply(this, args); }
    finally { cpuMs += performance.now() - start; }
  };
  gl.render = measuredRender;
  for (const { control } of snapshots) control.enabled = false;
  const previousLoop = state.frameloop;
  state.setFrameloop("always");
  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };
  const restore = () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("blur", onBlur);
    activeBenchmarks.delete(gl);
    if (gl.render === measuredRender) gl.render = originalRender;
    for (const snapshot of snapshots) {
      snapshot.control.enabled = snapshot.enabled;
      snapshot.control.object.position.copy(snapshot.position);
      snapshot.control.object.quaternion.copy(snapshot.quaternion);
      snapshot.control.object.up.copy(snapshot.up);
      snapshot.control.target.copy(snapshot.target);
    }
    if (store.getState().gl === gl) { state.setFrameloop(previousLoop); state.invalidate(); }
  };
  const stop = (reason) => {
    if (result.done) return;
    stopped = true;
    result.error = reason;
    result.valid = false;
    result.invalidation = { reason, at: Date.now(), dimensions: dimensions() };
    result.done = true;
    restore();
  };
  const onVisibilityChange = () => {
    if (document.hidden) stop("Benchmark cancelled because the page became hidden");
  };
  const onBlur = () => stop("Benchmark cancelled because the window lost focus");
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("blur", onBlur);
  let repetition = 0, start = performance.now(), previous = start;
  let intervals = [], submits = [];
  let rotatePhase = true, settleIntervals = [], settleSubmits = [];
  let peakCalls = 0, peakTriangles = 0, peakPoints = 0;
  const stats = (values, cpu) => ({ frames: values.length, p50: percentile(values, .5),
    p95: percentile(values, .95), p99: percentile(values, .99),
    over50ms: values.filter((x) => x > 50).length, cpuSubmitP95: percentile(cpu, .95) });
  const frame = (now) => {
    if (stopped || document.hidden) { stop("Benchmark cancelled or page hidden"); return; }
    // R3F can reapply Canvas.dpr during a React rerender. Never quietly mix
    // resolutions, layouts or renderer generations in the same result.
    if (JSON.stringify(dimensions()) !== signature) { stop("Benchmark dimensions/DPR changed"); return; }
    const current = store.getState();
    if (current.gl !== gl || current.frameloop !== "always" || gl.lifetime?.signal.aborted) {
      stop("Benchmark renderer or frame loop changed"); return;
    }
    const activeControls = [...new Set(current.internal.interaction.map((object) => object.__r3f?.root.getState().controls).filter(Boolean))];
    if (activeControls.length !== controls.length || activeControls.some((control, index) =>
      control !== controls[index] || control.object !== cameraObjects[index])) {
      stop("Benchmark view cameras changed"); return;
    }
    const elapsed = now - start;
    // "alternate" holds every other phase still so the settled frame cost and
    // the moving (re-sorting) cost can be compared inside one repetition.
    const settleWindow = motion === "alternate" && elapsed >= durationMs * settleRatio;
    if (motion === "alternate" && settleWindow === rotatePhase) rotatePhase = !rotatePhase;
    const rotating = motion !== "alternate" || !settleWindow;
    if (rotating) {
      for (const snapshot of snapshots) {
        const camera = snapshot.control.object;
        if (!camera.isPerspectiveCamera) continue;
        const dx = snapshot.position.x - snapshot.target.x;
        const dz = snapshot.position.z - snapshot.target.z;
        const angle = elapsed / 1000 * 0.35;
        camera.position.set(snapshot.target.x + dx * Math.cos(angle) + dz * Math.sin(angle),
          snapshot.position.y, snapshot.target.z + dz * Math.cos(angle) - dx * Math.sin(angle));
        camera.lookAt(snapshot.target);
      }
    }
    const renderInfo = gl.info?.render;
    if (renderInfo && elapsed >= warmupMs && previous - start >= warmupMs) {
      peakCalls = Math.max(peakCalls, renderInfo.calls ?? 0);
      peakTriangles = Math.max(peakTriangles, renderInfo.triangles ?? 0);
      peakPoints = Math.max(peakPoints, renderInfo.points ?? 0);
    }
    if (elapsed >= warmupMs && previous - start >= warmupMs) {
      const interval = now - previous;
      if (rotatePhase) { intervals.push(interval); submits.push(cpuMs); }
      else { settleIntervals.push(interval); settleSubmits.push(cpuMs); }
    }
    cpuMs = 0; previous = now;
    if (elapsed >= warmupMs + durationMs) {
      result.runs.push({ ...stats(intervals, submits), elapsedMs: elapsed, dimensions: dimensions(),
        memory: { ...gl.info.memory }, renderCalls: peakCalls, triangles: peakTriangles, points: peakPoints,
        motion: stats(intervals, submits),
        settle: motion === "alternate" && settleIntervals.length ? stats(settleIntervals, settleSubmits) : null });
      repetition++;
      if (repetition >= repetitions) { result.done = true; result.valid = true; restore(); return; }
      intervals = []; submits = []; settleIntervals = []; settleSubmits = [];
      peakCalls = 0; peakTriangles = 0; peakPoints = 0;
      rotatePhase = true;
      start = now;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return { result, cancel: () => stop("Benchmark cancelled") };
}
