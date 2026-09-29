import { describe, expect, test } from "bun:test";
import { Color, NoColorSpace, PerspectiveCamera, RenderTarget, Scene, Vector4 } from "three";
import { captureScene, unpackRGBA } from "./capture";
import type { NativeWebGPURenderer } from "./webgpu";
import { captureBudget } from "./ResourceBudget";

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
