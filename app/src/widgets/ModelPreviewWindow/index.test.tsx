import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { ModelPreviewWindow } from ".";

const mounted: { root: Root; container: HTMLElement }[] = [];

const EMPTY_ASSET: LibraryAsset = {
  id: "demo/empty",
  projectSlug: "demo",
  assetSlug: "empty",
  name: "空资产",
  kind: "model",
  modelPath: null,
  modelExt: null,
  mtlPath: null,
  spzPath: null,
  hdrPath: null,
  modelPaths: [],
  sourceImages: [],
  files: [],
  thumbPath: null,
  createdAt: "2026-08-09T00:00:00.000Z",
};

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

describe("ModelPreviewWindow 拖拽", () => {
  test("pointermove 只更新外壳 transform，不触发 React commit", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    let commits = 0;

    await act(async () => {
      root.render(
        createElement(
          Profiler,
          { id: "preview", onRender: () => commits++ },
          createElement(ModelPreviewWindow, {
            asset: EMPTY_ASSET,
            inspection: null,
            onClose: mock(() => {}),
            onInspectionCaptured: mock(() => {}),
          }),
        ),
      );
    });

    const windowShell = container.firstElementChild as HTMLDivElement;
    const dragHandle = windowShell.querySelector(".cursor-grab") as HTMLDivElement;
    dragHandle.setPointerCapture = mock(() => {});

    await act(async () => {
      dragHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 10,
          clientY: 20,
          pointerId: 1,
        }),
      );
      dragHandle.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 42,
          clientY: 65,
          pointerId: 1,
        }),
      );
    });

    expect(windowShell.style.transform).toBe("translate3d(32px, 45px, 0)");
    expect(commits).toBe(1);
  });
});
