import { describe, expect, test } from "bun:test";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { computeSceneLayout } from "./scenePlacement";

function modelAsset(overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: "uuid-chair",
    projectSlug: "demo",
    assetSlug: "chair",
    name: "Chair",
    kind: "model",
    modelPath: "projects/demo/assets/chair/0-chair.glb",
    modelExt: "glb",
    mtlPath: null,
    spzPath: null,
    worldSemantics: null,
    hdrPath: null,
    modelPaths: ["projects/demo/assets/chair/0-chair.glb"],
    sourceImages: [],
    files: ["0-chair.glb"],
    thumbPath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const PLACEMENT = {
  position: [1, 2, 3] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

describe("computeSceneLayout 的键语义", () => {
  /**
   * 这条是"删除后用同名 slug 重建不继承旧摆放"在客户端这一侧的地基：查表必须按稳定 id。
   * 如果哪天有人把它改回 `transforms[asset.assetSlug]`，这条会立刻红。
   */
  test("按资产稳定 id 查表，不按 slug", () => {
    const asset = modelAsset();
    const byId = computeSceneLayout([asset], { "uuid-chair": PLACEMENT });
    expect(byId.get("uuid-chair")).toEqual(PLACEMENT);

    // 存在 slug 键下的记录不该被采纳——那正是重建资产时的旧记录形态
    const bySlug = computeSceneLayout([asset], { chair: PLACEMENT });
    expect(bySlug.get("uuid-chair")).not.toEqual(PLACEMENT);
    // 没有记录就退化成网格默认位（位置在原点的那一格）
    expect(bySlug.get("uuid-chair")?.scale).toEqual([1, 1, 1]);
  });

  test("同 slug、不同 id 的两个资产各自取自己的记录", () => {
    const first = modelAsset({ id: "uuid-old", assetSlug: "chair" });
    const second = modelAsset({ id: "uuid-new", assetSlug: "chair" });
    const layout = computeSceneLayout(
      [first, second],
      { "uuid-old": PLACEMENT },
    );
    expect(layout.get("uuid-old")).toEqual(PLACEMENT);
    expect(layout.get("uuid-new")).not.toEqual(PLACEMENT);
  });
});
