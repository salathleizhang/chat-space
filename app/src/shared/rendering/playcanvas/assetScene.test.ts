import { describe, expect, test } from "bun:test";
import { Mat4, Quat, Vec3 } from "playcanvas";
import { createSceneAssets, type LoadedAssetLike, type SceneAssetSpec } from "./assetScene";
import { matrixFromPlacement, type Placement } from "./selectionTransform";

const placement = (over: Partial<Placement> = {}): Placement => ({
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...over,
});

/** 假实体：像引擎那样只存四元数（没有"欧拉三元组"这个成员）。 */
function fakeEntity() {
  const quat = new Quat();
  const position = new Vec3();
  const scale = new Vec3(1, 1, 1);
  return {
    quat, position, scale,
    enabled: true,
    destroyed: 0,
    getPosition: () => ({ x: position.x, y: position.y, z: position.z }),
    getRotation: () => ({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }),
    getLocalScale: () => ({ x: scale.x, y: scale.y, z: scale.z }),
    setPosition: (x: number, y: number, z: number) => position.set(x, y, z),
    setRotation: (rotation: { x: number; y: number; z: number; w: number }) => quat.set(rotation.x, rotation.y, rotation.z, rotation.w),
    setLocalScale: (x: number, y: number, z: number) => scale.set(x, y, z),
    destroy() { this.destroyed += 1; },
  };
}

function fixture() {
  const children: unknown[] = [];
  const removed: unknown[] = [];
  const loadedUrls: string[] = [];
  const errors: { id: string; error: unknown }[] = [];
  /** url → 该 url 的加载次数（用来证明"同 id 只是更新摆放，不重建"） */
  const loadCounts = new Map<string, number>();
  const fail = new Set<string>();
  const handle = createSceneAssets({
    addChild: (child) => { children.push(child); },
    removeChild: (child) => { removed.push(child); },
    loadModel: async (url): Promise<LoadedAssetLike> => {
      loadedUrls.push(url);
      loadCounts.set(url, (loadCounts.get(url) ?? 0) + 1);
      if (fail.has(url)) throw new Error(`加载失败 ${url}`);
      return { entity: fakeEntity(), dispose() { /* 由测试检查 destroy */ } };
    },
    createSplat: async (url): Promise<LoadedAssetLike> => {
      loadedUrls.push(url);
      loadCounts.set(url, (loadCounts.get(url) ?? 0) + 1);
      return { entity: fakeEntity(), dispose() { /* 同上 */ } };
    },
    onError: (spec, error) => { errors.push({ id: spec.id, error }); },
  });
  const spec = (id: string, over: Partial<SceneAssetSpec> = {}): SceneAssetSpec => ({
    id, kind: "model", url: `/${id}.glb`, placement: placement(), ...over,
  });
  return { handle, children, removed, loadedUrls, errors, loadCounts, fail, spec };
}

describe("资产 → 实体 挂载器", () => {
  test("世界的语义变换叠加在摆放上（+Y 朝下 ⇒ 先绕 X 转 π），且不改动记下来的用户摆放", async () => {
    const { handle, spec } = fixture();
    const semantics = { flipY: true, metricScaleFactor: 2, groundPlaneOffset: 0.5 };
    await handle.sync([spec("world", { kind: "splat", url: "/world.spz", worldSemantics: semantics })]);

    const entry = handle.entry("world")!;
    const entity = entry.entity as ReturnType<typeof fakeEntity>;
    // three 侧 `worldTransform()` 的同一份规则：绕 X π ⇒ q=(1,0,0,0)、y 平移、等比缩放
    expect(entity.quat.x).toBeCloseTo(1, 6);
    expect(entity.quat.w).toBeCloseTo(0, 6);
    expect(entity.position.y).toBeCloseTo(0.5, 6);
    expect(entity.scale.x).toBeCloseTo(2, 6);
    // 记账里仍是**用户摆放**（单位阵）：gizmo 写回的是这一份，不该被语义污染
    expect(entry.placement()).toEqual(placement());
  });

  test("没有语义字段的老世界数据：实体摆放就是用户摆放（不额外翻转）", async () => {
    const { handle, spec } = fixture();
    await handle.sync([spec("world", { kind: "splat", url: "/world.spz" })]);
    const entity = handle.entry("world")!.entity as ReturnType<typeof fakeEntity>;
    expect(entity.quat.x).toBeCloseTo(0, 6);
    expect(entity.quat.w).toBeCloseTo(1, 6);
  });


  test("sync 新增：每件资产一个实体，摆放按 three 约定写进实体", async () => {
    const f = fixture();
    const ready = await f.handle.sync([
      f.spec("a", { placement: placement({ position: [1, 2, 3], rotation: [0.3, 0.5, 0.9], scale: [2, 0.5, 1.5] }) }),
      f.spec("b", { kind: "splat", url: "/b.spz" }),
    ]);
    expect(ready).toBe(true);
    expect(f.handle.ids().sort()).toEqual(["a", "b"]);
    expect(f.children.length).toBe(2);
    const entry = f.handle.entry("a")!;
    // 实体上的四元数必须等于 three 约定下同一摆放的矩阵
    const entity = entry.entity as ReturnType<typeof fakeEntity>;
    const fromEntity: Placement = {
      position: [entity.position.x, entity.position.y, entity.position.z],
      rotation: [0, 0, 0],
      scale: [entity.scale.x, entity.scale.y, entity.scale.z],
    };
    // ⚠️ `matrixFromPlacement` 复用模块级的 tmp 向量，所以**两次连续调用必须各自绑定
    // 自己的输出矩阵**：不绑的话第二次调用会把第一次的 `expected` 一起改掉（踩过）。
    // **比的是"同一 position/scale、只差四元数"**：所以两边的 scale 必须相同。
    // 之前这里是 [2, .5, 1.5] 对 [1,1,1]，上半 3×3 差一个缩放倍数（世界矩阵里缩放与旋转相乘），
    // 报 0.836 的"旋转不一致"其实是缩放不一致（判据写错，不是实现错）。
    const rotationScale: Vec3 = new Vec3(1, 1, 1);
    const expected = matrixFromPlacement(
      placement({ position: [1, 2, 3], rotation: [0.3, 0.5, 0.9], scale: [1, 1, 1] }),
      new Mat4(),
    );
    const engineQuat = new Quat().copy(entity.quat);
    const viaQuat = new Mat4().setTRS(
      new Vec3(...fromEntity.position), engineQuat, rotationScale,
    );
    const worst = Math.max(...viaQuat.data.map((v, i) => Math.abs(v - expected.data[i]!)));
    expect(worst).toBeLessThan(1e-6);
  });

  test("sync 幂等：同 id 同 url 只更新摆放（不重建、不重复挂载）", async () => {
    const f = fixture();
    await f.handle.sync([f.spec("a", { placement: placement({ position: [1, 0, 0] }) })]);
    const first = f.handle.entry("a")!.entity;
    await f.handle.sync([f.spec("a", { placement: placement({ position: [5, 0, 0] }) })]);
    const entry = f.handle.entry("a")!;
    expect(entry.entity).toBe(first);          // 同一个实体
    expect(f.children.length).toBe(1);         // 只挂了一次
    expect(f.loadCounts.get("/a.glb")).toBe(1); // 只加载了一次
    expect((entry.entity as ReturnType<typeof fakeEntity>).position.x).toBe(5);
  });

  test("sync 移除：不再需要的资产会销毁并从场景摘掉", async () => {
    const f = fixture();
    await f.handle.sync([f.spec("a"), f.spec("b")]);
    const removedEntity = f.handle.entry("a")!.entity as ReturnType<typeof fakeEntity>;
    await f.handle.sync([f.spec("b")]);
    expect(f.handle.ids()).toEqual(["b"]);
    expect(removedEntity.destroyed).toBe(1);
    expect(f.removed).toContain(removedEntity);
  });

  test("URL 变了（换资产代次）→ 重建该件", async () => {
    const f = fixture();
    await f.handle.sync([f.spec("a", { url: "/a-v1.glb" })]);
    const first = f.handle.entry("a")!.entity;
    await f.handle.sync([f.spec("a", { url: "/a-v2.glb" })]);
    expect(f.handle.entry("a")!.entity).not.toBe(first);
    expect(f.loadCounts.get("/a-v2.glb")).toBe(1);
    expect((first as ReturnType<typeof fakeEntity>).destroyed).toBe(1);
  });

  test("单件加载失败不打断其它资产，并回调 onError", async () => {
    const f = fixture();
    f.fail.add("/bad.glb");
    const ready = await f.handle.sync([f.spec("good"), f.spec("bad", { url: "/bad.glb" }), f.spec("also")]);
    expect(ready).toBe(false); // 有失败 → 未全部就绪
    expect(f.handle.ids().sort()).toEqual(["also", "good"]);
    expect(f.errors.map((e) => e.id)).toEqual(["bad"]);
    expect(String(f.errors[0]!.error)).toContain("加载失败");
  });

  test("显隐与销毁：dispose 之后不再复活", async () => {
    const f = fixture();
    await f.handle.sync([f.spec("a")]);
    const entry = f.handle.entry("a")!;
    entry.setVisible(false);
    expect((entry.entity as ReturnType<typeof fakeEntity>).enabled).toBe(false);
    entry.setVisible(true);
    expect(entry.visible()).toBe(true);
    f.handle.dispose();
    expect((entry.entity as ReturnType<typeof fakeEntity>).destroyed).toBe(1);
    expect(f.removed).toContain(entry.entity);
    // dispose 之后的 sync 不会再建东西
    const after = await f.handle.sync([f.spec("a")]);
    expect(after).toBe(false);
    expect(f.children.length).toBe(1);
  });
});
