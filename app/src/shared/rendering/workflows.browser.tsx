import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { fetchLibraryAssets } from "../lib/libraryApi";
import { ThumbnailRenderer } from "../../widgets/ModelList/ThumbnailRenderer";
import { ModelPreviewWindow } from "../../widgets/ModelPreviewWindow";

/** Development-only integration probe. Reads an existing asset, renders the real
 * thumbnail/inspection components, and returns PNGs without uploading or editing
 * project data. Keep the page visible while running it.
 */
export async function verifyWebGPUWorkflows(projectSlug: string, assetSlug: string) {
  if (document.hidden) throw new Error("Keep the page visible during the GPU workflow test.");
  const asset = (await fetchLibraryAssets(projectSlug)).find((item) => item.assetSlug === assetSlug);
  if (!asset?.modelPath) throw new Error("A model asset is required.");
  const images: Record<string, string> = {};
  for (const mode of ["thumbnail", "inspection"] as const) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;top:0;left:0;width:352px;height:400px;z-index:1000";
    document.body.append(host);
    const root = createRoot(host);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      images[mode] = await new Promise<string>((resolve, reject) => {
        // A cold second WebGPU device and four-view shader compilation can
        // overlap. This is a validation deadline, not the product queue limit.
        timeout = setTimeout(() => reject(new Error(`${mode} timed out`)), 45_000);
        const captured = (png: string | null) => {
          if (!png) return reject(new Error(`${mode} returned no image`));
          if (host.querySelector("canvas")?.dataset.renderer !== "webgpu") return reject(new Error("Not a WebGPU surface"));
          resolve(png);
        };
        root.render(<StrictMode>{mode === "thumbnail"
          ? <ThumbnailRenderer asset={asset} onCaptured={(_, png) => captured(png)} />
          : <ModelPreviewWindow asset={asset} inspection={{ id: "webgpu-integration-test", target: "asset" }} onClose={() => {}} onInspectionCaptured={(_, png) => captured(png)} />
        }</StrictMode>);
      });
    } finally {
      clearTimeout(timeout);
      root.unmount();
      host.remove();
    }
  }
  return images;
}
