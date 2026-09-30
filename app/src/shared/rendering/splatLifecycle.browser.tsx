import { useFrame, useThree, type RootState } from "@react-three/fiber";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { GaussianSplatRenderer, type SplatMesh } from "gaussian-splat-lite";
import { fetchLibraryAssets, libraryUrl } from "../lib/libraryApi";
import SplatModel from "../../widgets/Viewport/SplatModel";
import { WebGPUCanvas } from "./WebGPUCanvas";
import { webgpuRenderer } from "./webgpu";

function ProbeViews({ onState }: { onState: (state: RootState) => void }) {
  const get = useThree((state) => state.get);
  useEffect(() => { onState(get()); }, [get, onState]);
  useFrame(({ gl, scene, camera }) => {
    gl.autoClear = false;
    const width = gl.domElement.width / 2, height = gl.domElement.height / 2;
    for (let index = 0; index < 4; index++) {
      camera.layers.mask = 1 | (1 << (index + 1));
      gl.setViewport(index % 2 * width, Math.floor(index / 2) * height, width, height);
      gl.setScissor(index % 2 * width, Math.floor(index / 2) * height, width, height);
      gl.setScissorTest(true);
      gl.render(scene, camera);
    }
    gl.setScissorTest(false);
  }, 1);
  return null;
}

/** Dev-only integration: same real SPZ, distinct URL generations. No asset
 * writes. Tests the actual component under StrictMode, not a mocked renderer.
 * This is a source-revision test, NOT 20 different worlds or project switches.
 */
export async function verifySplatLifecycle(projectSlug: string, assetSlug: string, cycles = 20) {
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 100) throw new Error("Invalid cycle count");
  const asset = (await fetchLibraryAssets(projectSlug)).find((item) => item.assetSlug === assetSlug);
  if (!asset?.spzPath || !asset.worldSemantics) throw new Error("A Splat world is required");
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:0;left:0;width:512px;height:512px;z-index:1000";
  document.body.append(host);
  const root = createRoot(host);
  let state: RootState | undefined, failure: Error | undefined;
  const onState = (value: RootState) => { state = value; };
  const onFailure = (error: Error) => { failure = error; };
  const rows: Array<{ cycle: number; readyMs: number; source: string; ids: string[]; active: number[]; memory: object }> = [];
  let renderers: GaussianSplatRenderer[] = [];
  let previousSource: string | undefined;
  const wait = async (condition: () => boolean, timeout = 45_000) => {
    const deadline = performance.now() + timeout;
    while (!condition()) {
      if (failure) throw failure;
      if (document.hidden) throw new Error("Splat lifecycle probe hidden");
      if (performance.now() > deadline) throw new Error(`Splat lifecycle timed out after cycle ${rows.length}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    for (let cycle = 0; cycle < cycles; cycle++) {
      const started = performance.now();
      root.render(<StrictMode><WebGPUCanvas dpr={1} frameloop="demand" camera={{ position: [5, 4.5, 5], fov: 45 }} onFailure={onFailure}>
        <ProbeViews onState={onState} />
        <SplatModel url={`${libraryUrl(asset.spzPath)}?revision=${asset.resourceRevision ?? 0}&lifecycleProbe=${cycle}`}
          semantics={asset.worldSemantics} />
      </WebGPUCanvas></StrictMode>);
      await wait(() => {
        if (!state) return false;
        const source = state.scene.getObjectByName("project-splats") as SplatMesh | undefined;
        if (!source || source.uuid === previousSource || source.numSplats === 0) return false;
        renderers = state.scene.children.filter((object): object is GaussianSplatRenderer => object instanceof GaussianSplatRenderer);
        // 一个实例服务全部窗格（一趟 ArrayCamera / multiView）；见 SplatModel 的说明。
        return renderers.length === 1 && renderers.every((renderer) => renderer.activeSplats === source.numSplats &&
          (renderer.geometry as unknown as { instanceCount: number }).instanceCount > 0);
      });
      const source = state!.scene.getObjectByName("project-splats")!;
      previousSource = source.uuid;
      const ids = renderers.map((renderer) => renderer.uuid);
      if (rows.length && ids.some((id, index) => id !== rows[0]!.ids[index])) throw new Error("Source revision recreated GPU renderers");
      rows.push({ cycle, readyMs: performance.now() - started, source: source.uuid, ids,
        active: renderers.map((renderer) => renderer.activeSplats), memory: { ...state!.gl.info.memory } });
    }
  } finally {
    root.unmount(); host.remove();
  }
  await wait(() => webgpuRenderer(state!.gl).lifetime.signal.aborted, 3000);
  return { rows, deviceReleased: true };
}
