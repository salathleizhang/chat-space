import { describe, expect, test } from "bun:test";
import { findGrabbedAsset, grabbedAssetId } from "./grabSelection";

/**
 * 这四类 `userData` 覆盖了"第一人称抓一下"会遇到的四种刚体。
 * 关键不是"能选中"，而是**前三种必须什么都不做**：写错时症状是"选中集里多了一个
 * 不存在的 id"，右侧栏空白、线框不出现，从画面上看不出根因。
 */
describe("grabbedAssetId", () => {
  test("资产刚体：取出 PhysicalAsset 写进去的 id", () => {
    expect(grabbedAssetId({ assetId: "asset-1" })).toBe("asset-1");
  });

  test("角色刚体（只有 character 标记）：不是资产，返回 null", () => {
    expect(grabbedAssetId({ character: true })).toBeNull();
  });

  test("空 id / 非字符串 id：一律当作没有", () => {
    expect(grabbedAssetId({ assetId: "" })).toBeNull();
    expect(grabbedAssetId({ assetId: 42 })).toBeNull();
    expect(grabbedAssetId({ assetId: null })).toBeNull();
  });

  test("没有 userData（未标记的刚体、地面、地形）：返回 null", () => {
    expect(grabbedAssetId(undefined)).toBeNull();
    expect(grabbedAssetId(null)).toBeNull();
    expect(grabbedAssetId("asset-1")).toBeNull();
  });
});

describe("findGrabbedAsset", () => {
  const second = { id: "asset-2" };
  const placed = [{ id: "asset-1" }, second];

  test("命中：返回**同一份**对象（上层按对象/ id 比对选中）", () => {
    expect(findGrabbedAsset(placed, "asset-2")).toBe(second);
  });

  test("id 不在已摆放列表里：返回 null（表示「不该改变选中」）", () => {
    expect(findGrabbedAsset(placed, "asset-gone")).toBeNull();
    expect(findGrabbedAsset([], "asset-1")).toBeNull();
  });
});
