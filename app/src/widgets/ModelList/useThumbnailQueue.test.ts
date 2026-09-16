import { act } from "react";
import { describe, expect, mock, test } from "bun:test";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { deferred, renderHook } from "../../test-utils";
import { useThumbnailQueue } from "./useThumbnailQueue";

function modelAsset(projectSlug: string, version: number): LibraryAsset {
  const assetSlug = "chair";
  const modelPath = `projects/${projectSlug}/assets/${assetSlug}/${version}-chair.glb`;
  return {
    id: `${projectSlug}/${assetSlug}`,
    projectSlug,
    assetSlug,
    name: "Chair",
    kind: "model",
    modelPath,
    modelExt: "glb",
    mtlPath: null,
    spzPath: null,
    hdrPath: null,
    modelPaths: [modelPath],
    sourceImages: [],
    files: [`${version}-chair.glb`],
    thumbPath: null,
    createdAt: null,
  };
}

type HookProps = Parameters<typeof useThumbnailQueue>[0];

describe("useThumbnailQueue", () => {
  test("同一资产排队期间换代：旧版本结算后继续渲染新版本", async () => {
    const v1 = modelAsset("p1", 1);
    const v2 = modelAsset("p1", 2);
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [], refreshKey: 0 },
    );

    await h.rerender({ projectSlug: "p1", assets: [v1], refreshKey: 1 });
    expect(h.result.current.current?.modelPath).toBe(v1.modelPath);

    // v1 仍在离屏 Canvas 中时，后台又产出了 v2；两份任务必须按源路径分别记账。
    await h.rerender({ projectSlug: "p1", assets: [v2], refreshKey: 2 });
    expect(h.result.current.current?.modelPath).toBe(v1.modelPath);

    await act(async () => {
      await Promise.resolve(h.result.current.onCaptured(v1, null));
    });
    expect(h.result.current.current?.modelPath).toBe(v2.modelPath);

    await h.unmount();
  });

  test("卸载后的缩略图上传不会再触发回填", async () => {
    const originalFetch = globalThis.fetch;
    const response = deferred<Response>();
    globalThis.fetch = mock(async () => response.promise) as unknown as typeof fetch;
    const onGenerated = mock(() => {});
    const p1Asset = modelAsset("p1", 1);
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [], refreshKey: 0, onGenerated },
    );

    try {
      await h.rerender({
        projectSlug: "p1",
        assets: [p1Asset],
        refreshKey: 1,
        onGenerated,
      });
      const oldCompletion = h.result.current.onCaptured(p1Asset, "cG5n");

      await h.unmount();

      response.resolve(Response.json({ path: "projects/p1/assets/chair/.thumb-1-chair.png" }));
      await act(async () => oldCompletion);

      expect(onGenerated).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
