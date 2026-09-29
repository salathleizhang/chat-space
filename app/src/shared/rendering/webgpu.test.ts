import { expect, test, spyOn } from "bun:test";
import { NativeWebGPURenderer, webgpuRenderer } from "./webgpu";

test("native renderer refuses WebGL objects", () => {
  expect(() => webgpuRenderer({} as Parameters<typeof webgpuRenderer>[0])).toThrow("native WebGPU");
});

test("failed WebGPU init cannot fall back or resurrect during disposal", async () => {
  const renderer = new NativeWebGPURenderer(document.createElement("canvas"));
  const backend = renderer.backend as typeof renderer.backend & { dispose(): Promise<void> };
  const init = spyOn(backend, "init").mockImplementation(() => { throw new Error("no adapter"); });
  const dispose = spyOn(backend, "dispose").mockResolvedValue(undefined);
  try {
    await expect(renderer.init()).rejects.toThrow("no adapter");
    expect(renderer.backend).toBe(backend);
    expect(renderer.initialized).toBe(false);
    expect(webgpuRenderer(renderer as unknown as Parameters<typeof webgpuRenderer>[0])).toBe(renderer);
    await renderer.dispose();
    await renderer.dispose();
    expect(init).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    init.mockRestore();
    dispose.mockRestore();
  }
});
