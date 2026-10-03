import { describe, expect, test } from "bun:test";
import type { AssetTransform } from "../dto/library";
import { comparePlaceable, computeSceneLayout, gridPosition } from "./sceneLayout";

const PLACEMENT: AssetTransform = {
  position: [1, 2, 3],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

function asset(id: string, slug: string, createdAt: string) {
  return { id, slug, createdAt };
}

describe("网格默认布局与 app 视口同源", () => {
  /**
   * 这两组数字直接对应 `app/src/widgets/Viewport/scenePlacement.ts` 的公式与它的测试。
   * 两侧任何一边改了列数、格距或行方向，这里就会红——"agent 说在 (3,0,-3)、视口画在
   * 别处"这类偏差必须在校验层被拦住，而不是等到摆放算错一整格。
   */
  test("6 个资产 = 3 列 2 行，行沿 −Z 增长", () => {
    const assets = [
      asset("id-0", "a", "2026-01-01T00:00:00.000Z"),
      asset("id-1", "b", "2026-01-01T00:00:01.000Z"),
      asset("id-2", "c", "2026-01-01T00:00:02.000Z"),
      asset("id-3", "d", "2026-01-01T00:00:03.000Z"),
      asset("id-4", "e", "2026-01-01T00:00:04.000Z"),
      asset("id-5", "f", "2026-01-01T00:00:05.000Z"),
    ];
    const layout = computeSceneLayout(assets);
    expect(layout.get("id-0")?.position).toEqual([-3, 0, 0]);
    expect(layout.get("id-1")?.position).toEqual([0, 0, 0]);
    expect(layout.get("id-2")?.position).toEqual([3, 0, 0]);
    expect(layout.get("id-3")?.position).toEqual([-3, 0, -3]);
    expect(layout.get("id-4")?.position).toEqual([0, 0, -3]);
    expect(layout.get("id-5")?.position).toEqual([3, 0, -3]);
  });

  test("少于 3 个时挤在中列：1 个在原点，2 个左右各半格", () => {
    expect(gridPosition(0, 1)).toEqual([0, 0, 0]);
    expect(gridPosition(0, 2)).toEqual([-1.5, 0, 0]);
    expect(gridPosition(1, 2)).toEqual([1.5, 0, 0]);
  });

  test("默认位是纯派生的：旋转为零、缩放为 1，手动记录逐字段覆盖", () => {
    const single = computeSceneLayout([asset("id-0", "chair", "2026-01-01T00:00:00.000Z")]);
    expect(single.get("id-0")).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    const saved = computeSceneLayout(
      [asset("id-0", "chair", "2026-01-01T00:00:00.000Z")],
      { "id-0": PLACEMENT },
    );
    expect(saved.get("id-0")).toEqual(PLACEMENT);
  });
});

describe("computeSceneLayout 的键语义", () => {
  /**
   * 与 app 侧 `scenePlacement.test.ts` 的同名用例一一对应：查表必须按稳定 id。
   * 记录存在 slug 键下（重建资产时的旧记录形态）不该被采纳。
   */
  test("按资产稳定 id 查表，不按 slug", () => {
    const chair = asset("uuid-chair", "chair", "2026-01-01T00:00:00.000Z");
    expect(computeSceneLayout([chair], { "uuid-chair": PLACEMENT }).get("uuid-chair")).toEqual(
      PLACEMENT,
    );
    const bySlug = computeSceneLayout([chair], { chair: PLACEMENT });
    expect(bySlug.get("uuid-chair")).not.toEqual(PLACEMENT);
    expect(bySlug.get("uuid-chair")?.position).toEqual([0, 0, 0]);
  });

  /**
   * 手动摆过的资产**仍占着原来那个序号**：不摘掉它，否则挪走一个模型会让后面所有
   * 模型集体前移一格（app 侧同一段注释）。这里用"第二个资产有记录"来钉住序号不受影响。
   */
  test("手动摆过的资产仍占自己那个格子，后面的资产不前移", () => {
    const first = asset("id-0", "a", "2026-01-01T00:00:00.000Z");
    const second = asset("id-1", "b", "2026-01-01T00:00:01.000Z");
    const third = asset("id-2", "c", "2026-01-01T00:00:02.000Z");
    const layout = computeSceneLayout([first, second, third], { "id-1": PLACEMENT });
    expect(layout.get("id-0")?.position).toEqual([-3, 0, 0]);
    expect(layout.get("id-1")).toEqual(PLACEMENT);
    expect(layout.get("id-2")?.position).toEqual([3, 0, 0]);
  });

  test("createdAt 相同则按 slug 排，顺序稳定", () => {
    const same = "2026-01-01T00:00:00.000Z";
    const order = [
      asset("id-b", "b", same),
      asset("id-a", "a", same),
    ].sort(comparePlaceable);
    expect(order.map((entry) => entry.slug)).toEqual(["a", "b"]);
    // 输入顺序反过来，结果必须一样
    expect(
      [asset("id-a", "a", same), asset("id-b", "b", same)]
        .sort(comparePlaceable)
        .map((entry) => entry.slug),
    ).toEqual(["a", "b"]);
  });
});
