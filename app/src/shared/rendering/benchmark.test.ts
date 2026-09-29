import { afterEach, expect, test, spyOn } from "bun:test";
import { PerspectiveCamera, Vector3 } from "three";
import { startRenderBenchmark } from "./benchmark.browser.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const restore of cleanup.splice(0).reverse()) restore(); });

function fixture() {
  let now = 0, sequence = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const raf = spyOn(globalThis, "requestAnimationFrame").mockImplementation((fn) => {
    callbacks.set(++sequence, fn); return sequence;
  });
  const cancel = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => { callbacks.delete(id); });
  const time = spyOn(performance, "now").mockImplementation(() => now);
  const focus = spyOn(document, "hasFocus").mockReturnValue(true);
  cleanup.push(() => { raf.mockRestore(); cancel.mockRestore(); time.mockRestore(); focus.mockRestore(); });
  const camera = new PerspectiveCamera();
  camera.position.set(5, 4.5, 5);
  const control = { enabled: true, object: camera, target: new Vector3() };
  const gl = { render: () => {}, getPixelRatio: () => 1, domElement: document.createElement("canvas"),
    info: { memory: {}, render: { calls: 0, triangles: 0, points: 0 } }, lifetime: new AbortController() };
  gl.domElement.width = 1920; gl.domElement.height = 1080;
  const state = { gl, controls: control, internal: { interaction: [] as object[] }, frameloop: "demand",
    invalidate() {}, setFrameloop(mode: string) { state.frameloop = mode; } };
  const store = { getState: () => state };
  state.internal.interaction.push({ __r3f: { root: store } });
  const start = (options = {}) => {
    const run = startRenderBenchmark(store, { durationMs: 30, warmupMs: 0, repetitions: 1, ...options });
    cleanup.push(run.cancel);
    return run;
  };
  return { start, state, camera, control, gl, step(at: number) {
    now = at;
    const pending = [...callbacks.values()]; callbacks.clear();
    for (const cb of pending) cb(now);
  } };
}

test("benchmark records stable dimensions and restores camera and loop", () => {
  const f = fixture(), render = f.gl.render;
  const run = f.start();
  f.step(10); f.step(20); f.step(30);
  expect(run.result.valid).toBe(true);
  expect(run.result.runs[0]?.dimensions).toMatchObject({ width: 1920, height: 1080, dpr: 1 });
  expect(f.camera.position.toArray()).toEqual([5, 4.5, 5]);
  expect(f.control.enabled).toBe(true);
  expect(f.state.frameloop).toBe("demand");
  expect(f.gl.render).toBe(render);
});

test("DPR/size drift invalidates the entire run, including completed repetitions", () => {
  const f = fixture(), run = f.start({ repetitions: 2 });
  f.step(30);
  f.gl.domElement.width = 2880;
  f.step(40);
  expect(run.result.done).toBe(true);
  expect(run.result.valid).toBe(false);
  expect(run.result.runs).toHaveLength(1);
  expect(run.result.error).toContain("dimensions/DPR");
  expect(run.result.invalidation?.dimensions.width).toBe(2880);
});

test("view replacement invalidates the run", () => {
  const f = fixture(), run = f.start();
  f.control.object = new PerspectiveCamera();
  f.step(10);
  expect(run.result.error).toContain("view cameras");
});

test("device loss invalidates the run", () => {
  const f = fixture(), run = f.start();
  f.gl.lifetime.abort(); f.step(10);
  expect(run.result.error).toContain("renderer or frame loop");
});

test("window blur invalidates and restores immediately", () => {
  const f = fixture(), run = f.start();
  window.dispatchEvent(new Event("blur"));
  expect(run.result.error).toContain("lost focus");
  expect(f.state.frameloop).toBe("demand");
});

test("duplicate runs and invalid timing are rejected without wrapping twice", () => {
  const f = fixture();
  expect(() => f.start({ durationMs: 0 })).toThrow("Invalid benchmark");
  const run = f.start(), render = f.gl.render;
  expect(() => f.start()).toThrow("already running");
  expect(f.gl.render).toBe(render);
  run.cancel();
  const next = f.start();
  f.step(30);
  expect(next.result.valid).toBe(true);
});

test("alternate motion separates the settled phase from the moving phase", () => {
  const f = fixture();
  const run = f.start({ motion: "alternate", settleRatio: 0.5, durationMs: 40, repetitions: 1 });
  // Distinct per-frame counts so the reported value is unambiguously the peak,
  // not a running total: max(1,7,3,9) = 9.
  for (const [at, tags] of [[10, 1], [20, 7], [30, 3], [40, 9]] as const) {
    f.gl.info.render.calls = tags;
    f.gl.info.render.triangles = tags * 2;
    f.gl.info.render.points = tags * 3;
    f.step(at);
  }
  expect(run.result.valid).toBe(true);
  const [entry] = run.result.runs;
  // Frames at t=20 (elapsed 20) and t=30 (elapsed 30) land at/after the settle
  // boundary; t=10 and before stay in the moving bucket.
  expect(entry?.settle).not.toBeNull();
  expect(entry!.motion.frames).toBeGreaterThan(0);
  expect(entry!.settle!.frames).toBeGreaterThan(0);
  expect(entry!.motion.frames + entry!.settle!.frames).toBe(entry!.frames);
  expect(entry!.renderCalls).toBe(9);
  expect(entry!.triangles).toBe(18);
  expect(entry!.points).toBe(27);
});

test("continuous motion reports no settled phase and stays backward compatible", () => {
  const f = fixture();
  const run = f.start({ durationMs: 30, repetitions: 1 });
  f.step(10); f.step(20); f.step(30);
  expect(run.result.valid).toBe(true);
  expect(run.result.runs[0]?.settle).toBeNull();
  expect(run.result.runs[0]?.motion.frames).toBe(run.result.runs[0]?.frames);
});

test("invalid motion and settle ratio are rejected", () => {
  const f = fixture();
  expect(() => f.start({ motion: "wobble" })).toThrow("Invalid benchmark motion");
  expect(() => f.start({ settleRatio: 2 })).toThrow("Invalid benchmark settle ratio");
});
