import { act } from "react";
import { describe, expect, mock, test } from "bun:test";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { deferred, flush, renderHook } from "../../test-utils";
import {
  MAX_THUMBNAIL_ATTEMPTS,
  THUMBNAIL_RETRY_BASE_MS,
  thumbnailSrc,
  useThumbnailQueue,
} from "./useThumbnailQueue";

function modelAsset(projectSlug: string, version: number, hasThumbnail = false): LibraryAsset {
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
    worldSemantics: null,
    hdrPath: null,
    modelPaths: [modelPath],
    sourceImages: [],
    files: [`${version}-chair.glb`],
    thumbPath: hasThumbnail
      ? `projects/${projectSlug}/assets/${assetSlug}/.thumb-${version}-chair.png`
      : null,
    createdAt: null,
  };
}

type HookProps = Parameters<typeof useThumbnailQueue>[0];

describe("useThumbnailQueue", () => {
  test("打开项目时会自动排队补齐历史资产缺失的缩略图", async () => {
    const v1 = modelAsset("p1", 1);
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [v1] },
    );

    expect(h.result.current.current?.modelPath).toBe(v1.modelPath);
    expect(h.result.current.pendingIds.has(v1.id)).toBe(true);
    await h.unmount();
  });

  test("已有匹配当前产物的缩略图时不重复生成", async () => {
    const v1 = modelAsset("p1", 1, true);
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [v1] },
    );

    expect(h.result.current.current).toBeNull();
    await h.unmount();
  });

  test("同一资产排队期间换代：立即淘汰旧版本，只渲染最新版本", async () => {
    const v1 = modelAsset("p1", 1);
    const v2 = modelAsset("p1", 2);
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [v1] },
    );
    expect(h.result.current.current?.modelPath).toBe(v1.modelPath);

    await h.rerender({ projectSlug: "p1", assets: [v2] });
    expect(h.result.current.current?.modelPath).toBe(v2.modelPath);

    // 已卸载的旧 Canvas 即使晚到结算，也不能移除或重试新版任务。
    await act(async () => {
      await Promise.resolve(h.result.current.onCaptured(v1, null));
    });
    expect(h.result.current.current?.modelPath).toBe(v2.modelPath);
    await h.unmount();
  });

  test("渲染失败会退避重试，但坏模型不会无限占用队列", async () => {
    const v1 = modelAsset("p1", 1);
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [v1] },
    );

    for (let attempt = 1; attempt <= MAX_THUMBNAIL_ATTEMPTS; attempt += 1) {
      await act(async () => {
        await Promise.resolve(h.result.current.onCaptured(v1, null));
      });
      expect(h.result.current.current).toBeNull();
      if (attempt < MAX_THUMBNAIL_ATTEMPTS) {
        await flush(THUMBNAIL_RETRY_BASE_MS * 2 ** (attempt - 1) + 30);
        expect(h.result.current.current?.modelPath).toBe(v1.modelPath);
      }
    }

    await flush(THUMBNAIL_RETRY_BASE_MS * 2 + 30);
    expect(h.result.current.current).toBeNull();
    await h.unmount();
  });

  test("磁盘缩略图读取失败时显示占位图并排队覆盖重建", async () => {
    const v1 = modelAsset("p1", 1, true);
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [v1] },
    );

    act(() => h.result.current.onImageError(v1));
    expect(thumbnailSrc(v1, h.result.current.generated, h.result.current.invalidImages)).toBeNull();
    await flush(THUMBNAIL_RETRY_BASE_MS + 30);
    expect(h.result.current.current?.modelPath).toBe(v1.modelPath);
    await h.unmount();
  });

  test("缩略图上传成功后结束任务并用缓存戳显示新图片", async () => {
    const originalFetch = globalThis.fetch;
    const v1 = modelAsset("p1", 1);
    const path = "projects/p1/assets/chair/.thumb-1-chair.png";
    const onGenerated = mock(() => {});
    globalThis.fetch = mock(async () => Response.json({ path })) as unknown as typeof fetch;
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [v1], onGenerated },
    );

    try {
      await act(async () => {
        await Promise.resolve(h.result.current.onCaptured(v1, "cG5n"));
      });
      expect(h.result.current.current).toBeNull();
      expect([...h.result.current.generated.values()][0]).toStartWith(`${path}?thumbnail=`);
      expect(onGenerated).toHaveBeenCalledWith(v1, v1.modelPath, path);
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });

  test("缩略图上传临时失败后会重试并最终完成", async () => {
    const originalFetch = globalThis.fetch;
    const v1 = modelAsset("p1", 1);
    const path = "projects/p1/assets/chair/.thumb-1-chair.png";
    let requests = 0;
    globalThis.fetch = mock(async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 })
        : Response.json({ path });
    }) as unknown as typeof fetch;
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [v1] },
    );

    try {
      await act(async () => {
        await Promise.resolve(h.result.current.onCaptured(v1, "cG5n"));
      });
      expect(h.result.current.current).toBeNull();
      await flush(THUMBNAIL_RETRY_BASE_MS + 30);
      expect(h.result.current.current?.modelPath).toBe(v1.modelPath);
      await act(async () => {
        await Promise.resolve(h.result.current.onCaptured(v1, "cG5n"));
      });
      expect(h.result.current.current).toBeNull();
      expect(requests).toBe(2);
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });

  test("卸载后的缩略图上传不会再触发回填", async () => {
    const originalFetch = globalThis.fetch;
    const response = deferred<Response>();
    globalThis.fetch = mock(async () => response.promise) as unknown as typeof fetch;
    const onGenerated = mock(() => {});
    const p1Asset = modelAsset("p1", 1);
    const h = await renderHook<HookProps, ReturnType<typeof useThumbnailQueue>>(
      (props: HookProps) => useThumbnailQueue(props),
      { projectSlug: "p1", assets: [p1Asset], onGenerated },
    );

    try {
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
