import { describe, expect, test } from "bun:test";
import {
  SCENE_SCHEMA_VERSION,
  assetStableId,
  createAssetIdentity,
  migrateSceneLayout,
  type AssetTransform,
} from "./library";

const TRANSFORM: AssetTransform = {
  position: [1, 2, 3],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

/** slug → 稳定 id；v3 迁移靠它把旧文档从 slug 键改写过来 */
const ids = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("migrateSceneLayout", () => {
  test("v1 的 slug 键被改写成稳定 id，内容原样保留", () => {
    const scene = migrateSceneLayout(
      {
        schemaVersion: 1,
        transforms: { chair: TRANSFORM },
        materials: { chair: { textures: { map: "projects/p/source/1-ref.png" } } },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      ids({ chair: "uuid-chair" }),
    );

    expect(scene.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    // 0 表示"迁移自旧版本、还没按新方案写过"
    expect(scene.revision).toBe(0);
    expect(scene.transforms["uuid-chair"]).toEqual(TRANSFORM);
    expect(scene.transforms.chair).toBeUndefined();
    expect(scene.materials["uuid-chair"]?.textures.map).toBe("projects/p/source/1-ref.png");
    expect(scene.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("v2 的 revision 在改写键时保留", () => {
    const scene = migrateSceneLayout(
      {
        schemaVersion: 2,
        transforms: { chair: TRANSFORM },
        materials: {},
        revision: 7,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      ids({ chair: "uuid-chair" }),
    );
    expect(scene.revision).toBe(7);
    expect(scene.transforms["uuid-chair"]).toEqual(TRANSFORM);
  });

  test("已经是 v3 的文档原样通过（幂等）", () => {
    const input = {
      schemaVersion: SCENE_SCHEMA_VERSION as typeof SCENE_SCHEMA_VERSION,
      transforms: { "uuid-chair": TRANSFORM },
      materials: {},
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    // 传一份"错误"的映射表：v3 不该再去查它，否则 key 会被二次改写
    expect(migrateSceneLayout(input, ids({ "uuid-chair": "should-not-be-used" }))).toEqual(input);
  });

  test("指向已不存在资产的 slug 用 slug: 前缀兜底，不被丢掉", () => {
    const scene = migrateSceneLayout(
      {
        schemaVersion: 1,
        transforms: { ghost: TRANSFORM },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      ids({}),
    );
    // 与老资产 asset.json 缺 id 时的派生规则一致，所以那个老资产仍能认领它
    expect(scene.transforms["slug:ghost"]).toEqual(TRANSFORM);
  });

  test("没有 schemaVersion 的手写文件按 v1 处理", () => {
    const scene = migrateSceneLayout(
      { transforms: { chair: TRANSFORM }, updatedAt: "2026-01-01T00:00:00.000Z" },
      ids({ chair: "uuid-chair" }),
    );
    expect(scene.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(scene.revision).toBe(0);
    expect(scene.transforms["uuid-chair"]).toEqual(TRANSFORM);
  });

  test("v1 缺 materials 时补空表", () => {
    const scene = migrateSceneLayout(
      { schemaVersion: 1, transforms: {}, updatedAt: "2026-01-01T00:00:00.000Z" },
      ids({}),
    );
    expect(scene.materials).toEqual({});
  });

  test("版本高于当前时明确报错，不猜着解析", () => {
    expect(() =>
      migrateSceneLayout(
        {
          schemaVersion: SCENE_SCHEMA_VERSION + 1,
          transforms: {},
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        ids({}),
      ),
    ).toThrow(/higher than the supported/);
  });

  test("不是场景文档时按契约报错", () => {
    expect(() => migrateSceneLayout({ nope: true }, ids({}))).toThrow(/does not match the contract/);
    expect(() => migrateSceneLayout(null, ids({}))).toThrow(/does not match the contract/);
  });

  test("旧文件里残留的无关键被丢掉", () => {
    const scene = migrateSceneLayout(
      {
        schemaVersion: 1,
        transforms: {},
        materials: { chair: { shader: "wireframe", textures: {} } },
        legacyFlag: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      ids({ chair: "uuid-chair" }),
    );
    expect(scene.materials["uuid-chair"]).not.toHaveProperty("shader");
    expect(scene).not.toHaveProperty("legacyFlag");
  });
});

describe("资产稳定身份", () => {
  test("createAssetIdentity 发新 id 并盖时间戳", () => {
    const input = {
      slug: "chair",
      kind: "model" as const,
      name: "Chair",
      intent: "a chair",
      sourceImages: [],
    };
    const first = createAssetIdentity(input);
    const second = createAssetIdentity(input);

    expect(first.schemaVersion).toBe(1);
    expect(first.id).toBeTruthy();
    expect(first.slug).toBe("chair");
    // 两次创建必须拿到不同的身份：同 slug 重建不该复用旧身份
    expect(first.id).not.toBe(second.id);
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
  });

  test("createAssetIdentity 允许调用方指定 createdAt", () => {
    const created = createAssetIdentity({
      slug: "chair",
      kind: "model",
      name: "Chair",
      intent: "a chair",
      sourceImages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(created.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("assetStableId：有 id 用 id，没有就按 slug 派生", () => {
    expect(assetStableId({ id: "uuid-1" }, "chair")).toBe("uuid-1");
    // 老工程的 asset.json 没有 id
    expect(assetStableId({}, "chair")).toBe("slug:chair");
    expect(assetStableId(undefined, "chair")).toBe("slug:chair");
  });
});
