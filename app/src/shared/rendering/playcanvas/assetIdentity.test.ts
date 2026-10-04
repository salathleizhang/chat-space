import { describe, expect, test } from "bun:test";
import { assetIdForEntity, type IdentityNode } from "./assetIdentity";

/**
 * 假实体必须照**引擎的形状**写：只有一个 `isDescendantOf(node)`（`GraphNode` 上的那个），
 * 没有别的方法可用——本仓库踩过"假数据比实现更好用"，于是实现里真的调了不存在的方法也测不出来。
 */
function node(ancestors: unknown[] = []): IdentityNode & { name: string } {
  return {
    name: "node",
    isDescendantOf(candidate: unknown) {
      return ancestors.includes(candidate);
    },
  };
}

const ids = ["a", "b"];

describe("assetIdForEntity", () => {
  test("命中就是资产根（抓取的就是这种情况：盒体碰撞体挂在根实体上）", () => {
    const rootA = node();
    expect(assetIdForEntity(ids, (id) => (id === "a" ? rootA : null), rootA)).toBe("a");
  });

  test("命中是资产的后代（点选拿到的是 mesh，不是根）", () => {
    const rootB = node();
    const child = node([rootB]);
    expect(assetIdForEntity(ids, (id) => (id === "b" ? rootB : null), child)).toBe("b");
  });

  test("命中是资产的祖先（回退方向也要成立）", () => {
    const parent = node();
    const rootA = node([parent]);
    expect(assetIdForEntity(ids, (id) => (id === "a" ? rootA : null), parent)).toBe("a");
  });

  test("不属于任何资产（地面/天空/锚点）：返回 null，而不是随便挑一个", () => {
    const rootA = node();
    const stranger = node();
    expect(assetIdForEntity(ids, (id) => (id === "a" ? rootA : null), stranger)).toBeNull();
  });

  test("根还没建好的条目跳过，后面那件仍然能解析", () => {
    const rootB = node();
    expect(assetIdForEntity(ids, (id) => (id === "b" ? rootB : null), rootB)).toBe("b");
  });

  test("空命中 / 空清单：返回 null（抓取射线的 hit.entity 可能是 undefined）", () => {
    expect(assetIdForEntity(ids, () => node(), null)).toBeNull();
    expect(assetIdForEntity(ids, () => node(), undefined)).toBeNull();
    expect(assetIdForEntity([], () => node(), node())).toBeNull();
  });

  test("有根实体但**没有** isDescendantOf（引擎形状变化）：只有同一个对象才算命中", () => {
    const bare: IdentityNode = {};
    expect(assetIdForEntity(["a"], () => bare, bare)).toBe("a");
    expect(assetIdForEntity(["a"], () => bare, {})).toBeNull();
  });
});
