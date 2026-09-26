import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { createLiveTransforms } from "../Viewport/liveTransforms";
import type { AssetPlacement } from "../Viewport/scenePlacement";
import { Inspector, type InspectorProps } from ".";

/**
 * 右侧栏的数字必须**跟着手走**，而不是等松手才跳一下。
 *
 * 这条链路和场景那侧是分开的：场景每帧命令式读实时表（零渲染），右侧栏靠订阅重渲染。
 * 所以这里钉两件事——数字确实跟着实时表动，以及**重渲染范围没有溢出到整块面板**。
 * 后者是性能约束，不是洁癖：面板里有贴图通道列表和缩略图，每帧重渲染它们等于白烧。
 */

const mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

/**
 * `modelPath: null` 让贴图区整段不渲染——那段要走 three 的 loader 与 Suspense，
 * 在 happy-dom 里没有网络回调，会把测试挂死。这里要测的是 Transform。
 */
const ASSET: LibraryAsset = {
  id: "demo/chair",
  projectSlug: "demo",
  assetSlug: "chair",
  name: "椅子",
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
  createdAt: "2026-09-01T00:00:00.000Z",
};

const COMMITTED = {
  position: [1, 2, 3] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

const DRAGGING: AssetPlacement = {
  position: [-4.5, 0.25, 7],
  rotation: [0, Math.PI / 2, 0],
  scale: [2, 2, 2],
};

function readFields(container: HTMLElement): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const input of container.querySelectorAll("input")) {
    const label = input.getAttribute("aria-label");
    if (label) fields[label] = (input as HTMLInputElement).value;
  }
  return fields;
}

/**
 * 模拟一次真实键入。不能直接写 `input.value = ...`：React 的受控输入挂了 value tracker，
 * 直接赋值会让它认为"值没变"而跳过 onChange。
 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mountInspector(props: Partial<InspectorProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  let inspectorRenders = 0;
  const Counted = (inner: InspectorProps) => {
    inspectorRenders += 1;
    return createElement(Inspector, inner);
  };
  const full = {
    asset: ASSET,
    transform: COMMITTED,
    onTransformChange: () => {},
    live: createLiveTransforms(),
    material: undefined,
    onMaterialChange: () => {},
    images: [],
    ...props,
  } satisfies InspectorProps;

  await act(async () => {
    root.render(createElement(Counted, full));
  });
  return { container, full, renders: () => inspectorRenders };
}

describe("Inspector 实时坐标", () => {
  test("没有拖拽时显示已提交的摆放", async () => {
    const { container } = await mountInspector();
    expect(readFields(container)["Position X"]).toBe("1");
    expect(readFields(container)["Position Z"]).toBe("3");
    expect(readFields(container)["Scale Y"]).toBe("1");
  });

  test("拖拽期间跟着实时表走，不必等松手提交", async () => {
    const { container, full } = await mountInspector();
    await act(async () => full.live.set(ASSET.id, DRAGGING));

    const fields = readFields(container);
    expect(fields["Position X"]).toBe("-4.5");
    expect(fields["Position Y"]).toBe("0.25");
    expect(fields["Position Z"]).toBe("7");
    // 旋转按度显示：π/2 弧度 → 90
    expect(fields["Rotation Y"]).toBe("90");
    expect(fields["Scale X"]).toBe("2");
  });

  test("实时值逐帧更新，不是只动一次", async () => {
    const { container, full } = await mountInspector();
    for (const x of [1, 2, 3]) {
      await act(async () =>
        full.live.set(ASSET.id, { ...DRAGGING, position: [x, 0, 0] }),
      );
      expect(readFields(container)["Position X"]).toBe(String(x));
    }
  });

  test("松手清表后回落到已提交的摆放", async () => {
    const { container, full } = await mountInspector();
    await act(async () => full.live.set(ASSET.id, DRAGGING));
    expect(readFields(container)["Position X"]).toBe("-4.5");

    await act(async () => full.live.clear());
    expect(readFields(container)["Position X"]).toBe("1");
  });

  test("每帧重渲染的范围只在输入格，不溢出到整块面板", async () => {
    const { full, renders } = await mountInspector();
    expect(renders()).toBe(1);

    await act(async () => full.live.set(ASSET.id, DRAGGING));
    await act(async () => full.live.set(ASSET.id, { ...DRAGGING, position: [9, 9, 9] }));

    // Inspector 本身一次都没重渲染：订阅住在 TransformSection 里
    expect(renders()).toBe(1);
  });

  test("别人的实时值不会带动本资产的数字", async () => {
    const { container, full } = await mountInspector();
    await act(async () => full.live.set("demo/table", DRAGGING));
    expect(readFields(container)["Position X"]).toBe("1");
  });

  test("正在输入时不被实时值抢走（编辑草稿优先）", async () => {
    const { container, full } = await mountInspector();
    const input = container.querySelector("input[aria-label=\"Position X\"]") as HTMLInputElement;

    await act(async () => {
      // React 19 的 onFocus 监听的是冒泡的 focusin，happy-dom 的 focus() 不会派发它
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      typeInto(input, "12.");
    });
    expect(input.value).toBe("12.");

    // 拖拽每帧把外部值推成 -4.5，但不该覆盖用户正在敲的草稿
    await act(async () => full.live.set(ASSET.id, DRAGGING));
    expect(input.value).toBe("12.");

    // 失焦后收口：草稿不合法就退回外部值
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(input.value).toBe("-4.5");
  });
});
