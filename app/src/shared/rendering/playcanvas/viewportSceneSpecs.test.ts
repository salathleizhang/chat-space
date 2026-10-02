import { describe, expect, test } from "bun:test";
import { computeSceneLayout } from "../../../widgets/Viewport/scenePlacement";
import {
  specKindFor, viewportSceneSpecs, withRevision, type ViewportAssetLike,
} from "./viewportSceneSpecs";

const asset = (over: Partial<ViewportAssetLike> & { id: string }): ViewportAssetLike => ({
  assetSlug: over.id, kind: "model", modelPath: `/${over.id}/0-${over.id}.glb`, spzPath: null, ...over,
});

describe("URL 上的修订号", () => {
  test("没有 query 用 ?，已有 query 用 &（写死会得到坏 URL）", () => {
    expect(withRevision("/a/0-a.glb", 7)).toBe("/a/0-a.glb?revision=7");
    expect(withRevision("/env/sky.exr?x=1", 3)).toBe("/env/sky.exr?x=1&revision=3");
    expect(withRevision("/a/0-a.glb", null)).toBe("/a/0-a.glb");
    expect(withRevision("/a/0-a.glb", undefined)).toBe("/a/0-a.glb");
    expect(withRevision("/a/0-a.glb", Number.NaN)).toBe("/a/0-a.glb");
  });
});

describe("资产 → 场景规格", () => {
  test("模型与点云各自成形；URL 带按资产发的修订号", () => {
    const assets = [
      asset({ id: "chair" }),
      asset({ id: "world", kind: "world", modelPath: null, spzPath: "/world/0-world.spz" }),
      asset({ id: "scan", kind: "world", modelPath: null, spzPath: "/scan/0-scan.spz" }),
    ];
    // 注意：computeSceneLayout 会排除 world（背景不参与摆放），所以 scan 用 kind:"other"+spz 来测点云那条路
    /*
      纯 splat（`modelPath: null`）**不参与网格布局**：`computeSceneLayout` 的判据是
      `kind !== "world" && a.modelPath`——没有模型产物的资产不该占掉一个网格位。
      所以这里它进 `skipped: no-placement` 而不是 specs（早先这条断言假设它会被布局进来，
      与现行口径不符）。点云那条路改由下面的 `withRevision` 与世界分支覆盖。
    */
    const splatOnly = asset({ id: "scan2", kind: "other", modelPath: null, spzPath: "/scan2/0-scan2.spz" });
    const layout = computeSceneLayout([
      { id: "chair", assetSlug: "chair", kind: "model", modelPath: "/chair/0-chair.glb", spzPath: null, createdAt: "1" },
    ] as never, {});
    const result = viewportSceneSpecs({
      assets: [assets[0]!, assets[1]!, splatOnly],
      layout: layout as unknown as Map<string, never>,
      revisionFor: (a) => (a.id === "chair" ? 7 : 9),
    });
    expect(result.specs.map((s) => [s.id, s.kind, s.url])).toEqual([
      ["chair", "model", "/chair/0-chair.glb?revision=7"],
    ]);
    // 没传 currentWorld 时世界显式列进跳过表（`other-world`），免得"背景没出现"无从判断；
    // 纯 splat 没有网格摆放 → `no-placement`（同样显式，不猜）
    expect(result.skipped).toEqual([
      { id: "world", reason: "other-world" },
      { id: "scan2", reason: "no-placement" },
    ]);
  });

  test("没有产物的资产跳过（贴图/动画/图片这类）", () => {
    expect(specKindFor(asset({ id: "tex", kind: "texture", modelPath: null }))).toBeNull();
    const result = viewportSceneSpecs({
      assets: [asset({ id: "tex", kind: "texture", modelPath: null })],
      layout: new Map(),
    });
    expect(result.specs).toEqual([]);
    expect(result.skipped).toEqual([{ id: "tex", reason: "no-product" }]);
  });

  test("有产物但没摆放：显式跳过，不猜摆位", () => {
    const result = viewportSceneSpecs({
      assets: [asset({ id: "chair" })],
      layout: new Map(),
    });
    expect(result.specs).toEqual([]);
    expect(result.skipped).toEqual([{ id: "chair", reason: "no-placement" }]);
  });

  test("摆放按**稳定 id** 取（不是 slug）：同名重建的资产拿不到旧摆放", () => {
    const layout = new Map([
      ["id-new", { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }],
    ]);
    const result = viewportSceneSpecs({
      assets: [asset({ id: "id-new", assetSlug: "chair" }), asset({ id: "id-old", assetSlug: "chair" })],
      layout,
    });
    expect(result.specs.map((s) => s.id)).toEqual(["id-new"]);
    expect(result.specs[0]!.placement.position).toEqual([1, 2, 3]);
    expect(result.skipped).toEqual([{ id: "id-old", reason: "no-placement" }]);
  });

  test("没有 revisionFor 时不带 query（探针/测试路径）", () => {
    const layout = new Map([
      ["a", { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }],
    ]);
    const result = viewportSceneSpecs({ assets: [asset({ id: "a" })], layout });
    expect(result.specs[0]!.url).toBe("/a/0-a.glb");
  });
});

describe("当前世界（场景背景）", () => {
  const world = asset({ id: "world-1", assetSlug: "world", kind: "world", modelPath: null, spzPath: "/world/0-world-500k.spz" });

  test("只发 currentWorld 指的那一份，用单位阵摆放（世界不参与网格布局）", () => {
    const result = viewportSceneSpecs({ assets: [world], layout: new Map(), currentWorld: "world" });
    expect(result.specs.map((s) => [s.id, s.kind, s.url, s.placement.position])).toEqual([
      ["world-1", "splat", "/world/0-world-500k.spz", [0, 0, 0]],
    ]);
    expect(result.skipped).toEqual([]);
  });

  test("gizmo 调过的世界摆放以 transforms 为准", () => {
    const placement = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [2, 2, 2] as [number, number, number] };
    const result = viewportSceneSpecs({ assets: [world], layout: new Map(), currentWorld: "world", transforms: { "world-1": placement } });
    expect(result.specs[0]!.placement).toEqual(placement);
  });

  test("不是当前世界的世界资产进 skipped（other-world），不渲染", () => {
    const other = asset({ id: "world-2", assetSlug: "another", kind: "world", modelPath: null, spzPath: "/w2.spz" });
    const result = viewportSceneSpecs({ assets: [world, other], layout: new Map(), currentWorld: "world" });
    expect(result.specs.map((s) => s.id)).toEqual(["world-1"]);
    expect(result.skipped).toEqual([{ id: "world-2", reason: "other-world" }]);
  });
});

test("urlFor 必须作用于**每一个**规格（模型与世界都算）", () => {
  const layout = new Map([["chair", { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }]]);
  const result = viewportSceneSpecs({
    assets: [asset({ id: "chair" }), asset({ id: "world-1", assetSlug: "world", kind: "world", modelPath: null, spzPath: "/world/0-world.spz" })],
    layout,
    currentWorld: "world",
    urlFor: (path) => `http://127.0.0.1:3901/api/library/${path}`,
  });
  expect(result.specs.map((s) => s.url)).toEqual([
    "http://127.0.0.1:3901/api/library//chair/0-chair.glb",
    "http://127.0.0.1:3901/api/library//world/0-world.spz",
  ]);
});
