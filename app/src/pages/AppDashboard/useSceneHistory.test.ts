import { act } from "react";
import { describe, expect, test } from "bun:test";
import type { AssetMaterial, AssetTransform } from "../../shared/lib/libraryApi";
import { createLiveTransforms } from "../../widgets/Viewport/liveTransforms";
import type { AssetPlacement } from "../../widgets/Viewport/scenePlacement";
import { renderHook } from "../../test-utils";
import { useSceneHistory, type SceneHistoryOptions } from "./useSceneHistory";

function at(position: [number, number, number]): AssetPlacement {
  return { position, rotation: [0, 0, 0], scale: [1, 1, 1] };
}

/**
 * 测试台：把"上层"的摆放表与材质表做成本地可变对象，这样 hook 里通过 latest.current
 * 读到的永远是测试修改过的最新值——与真实组件靠重渲染刷新闭包是同一效果。
 */
function setup() {
  const placements = new Map<string, AssetPlacement>();
  const materials: Record<string, AssetMaterial> = {};
  const transformsCalls: Record<string, AssetTransform>[] = [];
  const materialCalls: { assetSlug: string; material: AssetMaterial }[] = [];
  const known = new Set(["chair", "table"]);
  const live = createLiveTransforms();

  const options: SceneHistoryOptions = {
    resolvePlacement: (assetSlug) => placements.get(assetSlug),
    materials,
    isKnownAsset: (assetSlug) => known.has(assetSlug),
    assetLabel: (assetSlug) => (assetSlug === "chair" ? "Chair" : assetSlug),
    commitTransforms: (updates) => {
      transformsCalls.push(updates);
      // 模拟上层：状态更新后"生效摆放"跟着变
      for (const [assetSlug, transform] of Object.entries(updates)) {
        placements.set(assetSlug, transform);
      }
    },
    setMaterial: (assetSlug, material) => {
      materialCalls.push({ assetSlug, material });
      materials[assetSlug] = material;
    },
    live,
  };

  return { options, placements, materials, transformsCalls, materialCalls, known, live };
}

type Env = ReturnType<typeof setup>;

async function mount(env: Env) {
  return renderHook((props: SceneHistoryOptions) => useSceneHistory(props), env.options);
}

/** 包一层 act：栈的变动都会触发一次重渲染 */
async function run(fn: () => void) {
  await act(async () => {
    fn();
  });
}

describe("useSceneHistory", () => {
  test("拖拽一步可撤销、可重做，撤销写回改之前的值", async () => {
    const env = setup();
    env.placements.set("chair", at([1, 0, 0]));
    const harness = await mount(env);

    expect(harness.result.current.canUndo).toBe(false);
    await run(() => harness.result.current.commitPlacements({ chair: at([5, 0, 0]) }, "drag", "translate"));
    expect(harness.result.current.canUndo).toBe(true);
    expect(harness.result.current.undoLabel).toBe("Move Chair");
    expect(env.placements.get("chair")).toEqual(at([5, 0, 0]));

    await run(() => harness.result.current.undo());
    expect(env.placements.get("chair")).toEqual(at([1, 0, 0]));
    expect(harness.result.current.canUndo).toBe(false);
    expect(harness.result.current.canRedo).toBe(true);
    expect(harness.result.current.redoLabel).toBe("Move Chair");

    await run(() => harness.result.current.redo());
    expect(env.placements.get("chair")).toEqual(at([5, 0, 0]));
    expect(harness.result.current.canRedo).toBe(false);
  });

  test("撤销的新一步会清空重做分支", async () => {
    const env = setup();
    env.placements.set("chair", at([1, 0, 0]));
    const harness = await mount(env);

    await run(() => harness.result.current.commitPlacements({ chair: at([5, 0, 0]) }, "drag", "translate"));
    await run(() => harness.result.current.undo());
    expect(harness.result.current.canRedo).toBe(true);

    await run(() => harness.result.current.commitPlacements({ chair: at([9, 0, 0]) }, "drag", "translate"));
    expect(harness.result.current.canRedo).toBe(false);
  });

  test("右侧栏连续微调合并成一步，撤销回到微调之前", async () => {
    const env = setup();
    env.placements.set("chair", at([1, 0, 0]));
    const harness = await mount(env);

    // 输入格每敲一个能解析成数字的字符就提交一次，这里是"1" → "12" → "12.5"
    await run(() => harness.result.current.commitPlacements({ chair: at([1, 0, 1]) }, "field"));
    await run(() => harness.result.current.commitPlacements({ chair: at([1, 0, 12]) }, "field"));
    await run(() => harness.result.current.commitPlacements({ chair: at([1, 0, 12.5]) }, "field"));
    expect(env.placements.get("chair")).toEqual(at([1, 0, 12.5]));

    await run(() => harness.result.current.undo());
    // 一次撤销就回到微调之前，而不是停在中间的 12
    expect(env.placements.get("chair")).toEqual(at([1, 0, 0]));
    expect(harness.result.current.canUndo).toBe(false);
  });

  test("两次拖拽各占一步，不会被合并", async () => {
    const env = setup();
    env.placements.set("chair", at([1, 0, 0]));
    const harness = await mount(env);

    await run(() => harness.result.current.commitPlacements({ chair: at([2, 0, 0]) }, "drag", "translate"));
    await run(() => harness.result.current.commitPlacements({ chair: at([3, 0, 0]) }, "drag", "translate"));

    await run(() => harness.result.current.undo());
    expect(env.placements.get("chair")).toEqual(at([2, 0, 0]));
    expect(harness.result.current.canUndo).toBe(true);
    await run(() => harness.result.current.undo());
    expect(env.placements.get("chair")).toEqual(at([1, 0, 0]));
  });

  test("多选拖拽是一步：一次撤销还原全部成员", async () => {
    const env = setup();
    env.placements.set("chair", at([1, 0, 0]));
    env.placements.set("table", at([0, 0, 1]));
    const harness = await mount(env);

    await run(() =>
      harness.result.current.commitPlacements(
        { chair: at([5, 0, 0]), table: at([0, 0, 5]) },
        "drag",
        "rotate",
      ),
    );
    expect(harness.result.current.undoLabel).toBe("Rotate 2 objects");

    await run(() => harness.result.current.undo());
    expect(env.placements.get("chair")).toEqual(at([1, 0, 0]));
    expect(env.placements.get("table")).toEqual(at([0, 0, 1]));
    expect(harness.result.current.canUndo).toBe(false);
  });

  test("换贴图可撤销，首次改动的 before 是默认材质", async () => {
    const env = setup();
    const harness = await mount(env);

    await run(() =>
      harness.result.current.commitMaterial("chair", { textures: { map: "projects/p/source/1-a.png" } }),
    );
    expect(env.materials.chair).toEqual({ textures: { map: "projects/p/source/1-a.png" } });
    expect(harness.result.current.undoLabel).toBe("Change texture of Chair");

    await run(() => harness.result.current.undo());
    // 默认材质就是"一张都不换"，写回它与"没有记录"等价
    expect(env.materialCalls.at(-1)?.material).toEqual({ textures: {} });

    await run(() => harness.result.current.redo());
    expect(env.materials.chair).toEqual({ textures: { map: "projects/p/source/1-a.png" } });
  });

  test("资产已被删除时撤销不写回孤儿记录", async () => {
    const env = setup();
    env.placements.set("chair", at([1, 0, 0]));
    const harness = await mount(env);

    await run(() => harness.result.current.commitPlacements({ chair: at([5, 0, 0]) }, "drag", "translate"));
    const callsBefore = env.transformsCalls.length;
    env.known.delete("chair");

    await run(() => harness.result.current.undo());
    // 撤销被跳过，但这一步已经出栈（不会卡在栈顶反复尝试）
    expect(env.transformsCalls.length).toBe(callsBefore);
    expect(harness.result.current.canUndo).toBe(false);
    expect(harness.result.current.canRedo).toBe(true);
  });

  test("拖拽进行中忽略撤销：画面此刻由实时表决定", async () => {
    const env = setup();
    env.placements.set("chair", at([1, 0, 0]));
    const harness = await mount(env);

    await run(() => harness.result.current.commitPlacements({ chair: at([5, 0, 0]) }, "drag", "translate"));
    const callsBefore = env.transformsCalls.length;
    env.live.set("chair", at([7, 0, 0]));

    await run(() => harness.result.current.undo());
    expect(env.transformsCalls.length).toBe(callsBefore);
    expect(harness.result.current.canUndo).toBe(true);
    env.live.clear();
  });

  test("查不到改之前的摆放就不入栈（宁可不撤销，也不记一步错的）", async () => {
    const env = setup();
    // chair 存在但没有任何生效摆放
    const harness = await mount(env);

    await run(() => harness.result.current.commitPlacements({ chair: at([5, 0, 0]) }, "drag", "translate"));
    expect(env.placements.get("chair")).toEqual(at([5, 0, 0]));
    expect(harness.result.current.canUndo).toBe(false);
  });

  test("Cmd/Ctrl+Z 撤销、Shift 加大写 Z 重做；输入框里不抢", async () => {
    const env = setup();
    env.placements.set("chair", at([1, 0, 0]));
    const harness = await mount(env);

    await run(() => harness.result.current.commitPlacements({ chair: at([5, 0, 0]) }, "drag", "translate"));

    // 焦点在输入框里：那是"撤销打字"，不该动场景
    const input = document.createElement("input");
    document.body.appendChild(input);
    await run(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    });
    expect(env.placements.get("chair")).toEqual(at([5, 0, 0]));
    input.remove();

    await run(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    });
    expect(env.placements.get("chair")).toEqual(at([1, 0, 0]));

    await run(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Z", metaKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(env.placements.get("chair")).toEqual(at([5, 0, 0]));

    await harness.unmount();
  });
});
