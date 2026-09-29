import { describe, expect, test } from "bun:test";
import { BoxGeometry, Color, Group, Mesh, MeshBasicMaterial, NoColorSpace, PerspectiveCamera, RenderTarget, Scene, Vector4 } from "three";
import { captureScene, unpackRGBA } from "./capture";
import type { NativeWebGPURenderer } from "./webgpu";
import { captureBudget, captureBytes } from "./ResourceBudget";
import { modelResources } from "./ModelResources";

describe("WebGPU readback", () => {
  test("keeps packed RGBA including alpha and top-to-bottom row order", () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 42]);
    expect([...unpackRGBA(pixels, 1, 2)]).toEqual([...pixels]);
  });

  test("strips 256-byte padding, including an unpadded final row", () => {
    for (const length of [520, 768]) {
      const pixels = new Uint8Array(length).fill(99);
      pixels.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
      pixels.set([11, 12, 13, 14, 15, 16, 17, 18], 256);
      pixels.set([21, 22, 23, 24, 25, 26, 27, 28], 512);
      expect([...unpackRGBA(pixels, 2, 3)]).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18,
        21, 22, 23, 24, 25, 26, 27, 28,
      ]);
    }
  });

  test("rejects incomplete rows", () => {
    expect(() => unpackRGBA(new Uint8Array(259), 1, 2)).toThrow("Incomplete");
  });

  test("copies bytes without retaining the mapped GPU buffer", () => {
    const pixels = new Uint8Array([1, 2, 3, 4]);
    const output = unpackRGBA(pixels, 1, 1);
    pixels.fill(0);
    expect([...output]).toEqual([1, 2, 3, 4]);
  });
});

function rendererFixture(renderThrows = false) {
  const original = new RenderTarget(8, 8);
  let target: RenderTarget | null = original;
  let output: RenderTarget | null = null;
  const viewport = new Vector4(2, 3, 4, 5);
  const scissor = new Vector4(6, 7, 8, 9);
  let scissorTest = true;
  let disposed = 0;
  let rejectRead!: (reason: Error) => void;
  const readback = new Promise<Uint8Array>((_, reject) => { rejectRead = reject; });
  const renderer = {
    lost: false, autoClear: false, samples: 4,
    getOutputRenderTarget: () => output,
    setOutputRenderTarget: (next: RenderTarget | null) => { output = next; },
    getRenderTarget: () => target,
    setRenderTarget: (next: RenderTarget | null) => { target = next; },
    getViewport: (out: Vector4) => out.copy(viewport),
    setViewport: (next: Vector4) => { viewport.copy(next); },
    getScissor: (out: Vector4) => out.copy(scissor),
    setScissor: (next: Vector4) => { scissor.copy(next); },
    getScissorTest: () => scissorTest,
    setScissorTest: (next: boolean) => { scissorTest = next; },
    getClearColor: (out: Color) => out.set("red"),
    getClearAlpha: () => 0.3,
    setClearColor: (color: Color, alpha: number) => {
      expect(color.getHexString()).toBe("ff0000"); expect(alpha).toBe(0.3);
    },
    render: () => {
      expect(target).not.toBe(original);
      expect(output).toBe(target);
      expect(target!.texture.colorSpace).toBe(NoColorSpace);
      expect(target!.samples).toBe(4);
      target!.addEventListener("dispose", () => { disposed++; });
      expect(scissorTest).toBe(false);
      expect(renderer.autoClear).toBe(true);
      viewport.set(0, 0, 256, 256);
      scissor.set(0, 0, 256, 256);
      if (renderThrows) throw new Error("render failed");
    },
    readRenderTargetPixelsAsync: () => readback,
  };
  const expectRestored = () => {
    expect(target).toBe(original);
    expect(output).toBeNull();
    expect(viewport.toArray()).toEqual([2, 3, 4, 5]);
    expect(scissor.toArray()).toEqual([6, 7, 8, 9]);
    expect(scissorTest).toBe(true);
    expect(renderer.autoClear).toBe(false);
  };
  return { renderer: renderer as unknown as NativeWebGPURenderer, expectRestored, rejectRead, disposed: () => disposed };
}

describe("capture state isolation", () => {
  test("state snapshot failure releases the reserved budget", async () => {
    const fixture = rendererFixture();
    fixture.renderer.getViewport = () => { throw new Error("renderer unavailable"); };
    const before = captureBudget.stats.used;
    await expect(captureScene(fixture.renderer, new Scene(), new PerspectiveCamera(), 256)).rejects.toThrow("unavailable");
    expect(captureBudget.stats.used).toBe(before);
  });
  test("restores state before async readback and disposes target on rejection", async () => {
    const fixture = rendererFixture();
    const result = captureScene(fixture.renderer, new Scene(), new PerspectiveCamera(), 256);
    fixture.expectRestored();
    expect(fixture.disposed()).toBe(0);
    fixture.rejectRead(new Error("readback failed"));
    await expect(result).rejects.toThrow("readback failed");
    expect(fixture.disposed()).toBe(1);
  });

  test("restores state and disposes target when drawing throws", async () => {
    const fixture = rendererFixture(true);
    await expect(captureScene(fixture.renderer, new Scene(), new PerspectiveCamera(), 256)).rejects.toThrow("render failed");
    fixture.expectRestored();
    expect(fixture.disposed()).toBe(1);
  });

  test("refuses capture on a lost device before allocating a target", async () => {
    await expect(captureScene({ lost: true } as NativeWebGPURenderer, new Scene(), new PerspectiveCamera(), 256)).rejects.toThrow("GPU connection lost");
  });
});

/** Renderer fake that completes a capture at whatever edge it is asked for. */
function captureFixture(samples = 4) {
  const original = new RenderTarget(8, 8);
  let target: RenderTarget | null = original;
  let output: RenderTarget | null = null;
  const viewport = new Vector4(0, 0, 1, 1), scissor = new Vector4(0, 0, 1, 1);
  const draws: number[] = [], reads: Array<[number, number]> = [];
  const renderer = {
    lost: false, autoClear: true, samples,
    getOutputRenderTarget: () => output,
    setOutputRenderTarget: (next: RenderTarget | null) => { output = next; },
    getRenderTarget: () => target,
    setRenderTarget: (next: RenderTarget | null) => { target = next; },
    getViewport: (out: Vector4) => out.copy(viewport),
    setViewport: (next: Vector4) => { viewport.copy(next); },
    getScissor: (out: Vector4) => out.copy(scissor),
    setScissor: (next: Vector4) => { scissor.copy(next); },
    getScissorTest: () => false,
    setScissorTest: () => {},
    getClearColor: (out: Color) => out.set("black"),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    render: () => { draws.push(target!.width); },
    readRenderTargetPixelsAsync: (_target: RenderTarget, _x: number, _y: number, width: number, height: number) => {
      reads.push([width, height]);
      return Promise.resolve(new Uint8Array(width * height * 4));
    },
  };
  return { renderer: renderer as unknown as NativeWebGPURenderer, draws, reads };
}

/** happy-dom exposes no 2D context; record the encoded frame instead. */
function stubCanvas2d() {
  const encoded: ImageData[] = [];
  const canvasPrototype = HTMLCanvasElement.prototype as unknown as { getContext: () => unknown };
  const original = canvasPrototype.getContext;
  canvasPrototype.getContext = function (this: HTMLCanvasElement) {
    return { putImageData: (data: ImageData) => encoded.push(data) };
  };
  return { encoded, restore: () => { canvasPrototype.getContext = original; } };
}

/** Leave exactly `remaining` bytes free, so only captures below `size` can fit. */
function holdBudget(remaining: number) {
  const available = captureBudget.limit - captureBudget.stats.used;
  return captureBudget.reserve(available - remaining);
}

describe("capture budget degradation", () => {
  test("keeps the requested size when the budget fits", async () => {
    const canvas2d = stubCanvas2d();
    const fixture = captureFixture();
    const before = captureBudget.stats.used, downgrades = captureBudget.downgrades.count;
    let canvas: HTMLCanvasElement;
    try {
      canvas = await captureScene(fixture.renderer, new Scene(), new PerspectiveCamera(), 512);
    } finally {
      canvas2d.restore();
    }
    expect(canvas.width).toBe(512); expect(canvas.height).toBe(512);
    expect(fixture.draws).toEqual([512]);
    expect(fixture.reads).toEqual([[512, 512]]);
    expect(canvas2d.encoded.map((data) => [data.width, data.height, data.data.length])).toEqual([[512, 512, 512 * 512 * 4]]);
    expect(captureBudget.stats.used).toBe(before);
    expect(captureBudget.downgrades.count).toBe(downgrades);
  });

  test("halves the resolution when only the smaller step fits and returns that canvas", async () => {
    const canvas2d = stubCanvas2d();
    const fixture = captureFixture();
    const hold = holdBudget(captureBytes(256, 4));
    const before = captureBudget.stats.used, downgrades = captureBudget.downgrades.count;
    let canvas: HTMLCanvasElement, usedAfter = -1;
    try {
      canvas = await captureScene(fixture.renderer, new Scene(), new PerspectiveCamera(), 512);
      usedAfter = captureBudget.stats.used;
    } finally {
      canvas2d.restore(); hold();
    }
    expect(canvas.width).toBe(256); expect(canvas.height).toBe(256);
    expect(fixture.draws).toEqual([256]);
    expect(fixture.reads).toEqual([[256, 256]]);
    expect(canvas2d.encoded.map((data) => [data.width, data.height, data.data.length])).toEqual([[256, 256, 256 * 256 * 4]]);
    expect(captureBudget.downgrades).toEqual({ count: downgrades + 1, last: { requested: 512, actual: 256 } });
    expect(usedAfter).toBe(before);
  });

  test("fails at the floor with an actionable error and releases the budget", async () => {
    const fixture = captureFixture();
    const hold = holdBudget(captureBytes(256, 4) - 1);
    const used = captureBudget.stats.used, rejected = captureBudget.stats.rejected;
    let usedAfter = -1;
    try {
      await expect(captureScene(fixture.renderer, new Scene(), new PerspectiveCamera(), 512))
        .rejects.toThrow(/capture budget exceeded: limit .*need .*at 256px \(requested 512px, floor 256px\)/);
      usedAfter = captureBudget.stats.used;
    } finally {
      hold();
    }
    expect(usedAfter).toBe(used);
    expect(captureBudget.stats.rejected).toBe(rejected + 1);
    expect(fixture.draws).toEqual([]); expect(fixture.reads).toEqual([]);
  });

  test("degrades without releasing model resources that are still in use", async () => {
    const canvas2d = stubCanvas2d();
    const geometry = new BoxGeometry();
    const root = new Group(); root.add(new Mesh(geometry, new MeshBasicMaterial()));
    let clears = 0, disposals = 0, idleClears = 0;
    geometry.addEventListener("dispose", () => disposals++);
    const release = modelResources.acquire(root, () => clears++);
    for (let index = 0; index < modelResources.maxIdleEntries + 1; index++) {
      const idle = new Group(); idle.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
      modelResources.acquire(idle, () => idleClears++)();
    }
    const evicted = modelResources.stats.evicted;
    const hold = holdBudget(captureBytes(256, 4));
    let canvas: HTMLCanvasElement;
    try {
      canvas = await captureScene(captureFixture().renderer, new Scene(), new PerspectiveCamera(), 512);
    } finally {
      canvas2d.restore(); hold(); release();
    }
    expect(canvas.width).toBe(256);
    expect(clears).toBe(0); expect(disposals).toBe(0);
    expect(idleClears).toBeGreaterThan(0);
    expect(modelResources.stats.evicted).toBeGreaterThan(evicted);
  });
});
