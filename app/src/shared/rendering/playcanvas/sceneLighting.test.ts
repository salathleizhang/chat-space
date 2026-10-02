import { describe, expect, test } from "bun:test";
import {
  createSceneLighting,
  DEFAULT_AMBIENT_LIGHT,
  DEFAULT_DIRECTIONAL_LIGHTS,
  DEFAULT_ENVIRONMENT_URL,
  environmentCandidates,
  type LightingAppLike,
  type LightEntityLike,
} from "./sceneLighting";

/**
 * 这里**不加载引擎**：`createSceneLighting` 的两个引擎入口（`Entity` / `Color`）都能注入，
 * 所以能断言"我们到底建了什么"。真正的 GPU 行为（画面是否变亮）只能在真实浏览器里量，
 * 读数与截图见 `PLAYCANVAS_MIGRATION.md` §三之十四 增量 18。
 */

interface EntityRecord {
  name: string;
  components: { type: string; data?: Record<string, unknown> }[];
  position: [number, number, number] | null;
  lookedAt: [number, number, number] | null;
  destroyed: boolean;
}

function fakeEntityFactory() {
  const records: EntityRecord[] = [];
  const createEntity = (name: string): LightEntityLike => {
    const record: EntityRecord = { name, components: [], position: null, lookedAt: null, destroyed: false };
    records.push(record);
    return {
      addComponent(type, data) { record.components.push({ type, data }); return record; },
      setPosition(x, y, z) { record.position = [x, y, z]; },
      lookAt(x, y, z) { record.lookedAt = [x, y, z]; },
      destroy() { record.destroyed = true; },
    };
  };
  return { createEntity, records };
}

function fakeApp() {
  const app: LightingAppLike & { added: unknown[] } = {
    scene: { ambientLight: null },
    root: { addChild(child) { app.added.push(child); } },
    added: [],
  };
  return app;
}

describe("默认光照的数值（与 three 侧同一份契约）", () => {
  test("环境光是 0.6、两盏平行光是 (4,6,4)/1.4 与 (-4,2,-3)/0.4", () => {
    // 逐项对齐 `widgets/Viewport/index.tsx` 的 <ambientLight>/<directionalLight>：
    // 这两边**必须同值**，否则同一个项目在 `?pcViewport=1` 前后会是两种明暗。
    expect([...DEFAULT_AMBIENT_LIGHT]).toEqual([0.6, 0.6, 0.6]);
    expect(DEFAULT_DIRECTIONAL_LIGHTS.map((light) => [light.position, light.intensity])).toEqual([
      [[4, 6, 4], 1.4],
      [[-4, 2, -3], 0.4],
    ]);
  });
});

describe("createSceneLighting", () => {
  test("写 scene.ambientLight，并逐盏建平行光实体挂到 root", async () => {
    const app = fakeApp();
    const { createEntity, records } = fakeEntityFactory();
    const handle = await createSceneLighting(app, {
      createEntity,
      createColor: (r, g, b) => ({ r, g, b }),
    });

    expect(app.scene.ambientLight).toEqual({ r: 0.6, g: 0.6, b: 0.6 });
    expect(records).toHaveLength(2);
    expect(app.added).toHaveLength(2);
    expect(app.added).toEqual([...handle.entities()]);

    // 组件参数：方向光 + 白颜色 + three 侧的强度
    expect(records[0]!.components).toEqual([
      { type: "light", data: { type: "directional", color: { r: 1, g: 1, b: 1 }, intensity: 1.4 } },
    ]);
    expect(records[1]!.components[0]!.data!.intensity).toBe(0.4);

    // 方向用 lookAt(0,0,0) 表达（引擎平行光方向是实体 −Z），不是手写欧拉角
    expect(records[0]!.position).toEqual([4, 6, 4]);
    expect(records[0]!.lookedAt).toEqual([0, 0, 0]);
    expect(records[1]!.position).toEqual([-4, 2, -3]);
    expect(records[1]!.lookedAt).toEqual([0, 0, 0]);
  });

  test("灯名逐盏不同（同名实体在引擎场景图里没法区分诊断）", async () => {
    const app = fakeApp();
    const { createEntity, records } = fakeEntityFactory();
    await createSceneLighting(app, { createEntity, createColor: () => ({}) });
    expect(new Set(records.map((record) => record.name)).size).toBe(records.length);
  });

  test("dispose 销毁每一盏灯，且句柄不再报出它们", async () => {
    const app = fakeApp();
    const { createEntity, records } = fakeEntityFactory();
    const handle = await createSceneLighting(app, { createEntity, createColor: () => ({}) });
    const alive = handle.entities();

    handle.dispose();

    expect(records.every((record) => record.destroyed)).toBe(true);
    expect(handle.entities()).toEqual([]);
    // 第二遍 dispose 不该抛（清理路径可能被 React 跑两次）
    expect(() => handle.dispose()).not.toThrow();
    expect(alive).toHaveLength(2);
  });

  test("可以注入别的光照表（测试/未来预设复用同一条路）", async () => {
    const app = fakeApp();
    const { createEntity, records } = fakeEntityFactory();
    await createSceneLighting(app, {
      createEntity,
      createColor: (r, g, b) => ({ r, g, b }),
      ambient: [0, 0, 0],
      lights: [{ intensity: 2, position: [0, 1, 0] }],
    });
    expect(app.scene.ambientLight).toEqual({ r: 0, g: 0, b: 0 });
    expect(records).toHaveLength(1);
    expect(records[0]!.components[0]!.data!.intensity).toBe(2);
  });
});

describe("环境贴图候选表", () => {
  test("项目产物优先，默认兜底在后", () => {
    expect(environmentCandidates("projects/p/assets/sky/3-sky.jpg")).toEqual([
      "projects/p/assets/sky/3-sky.jpg",
      DEFAULT_ENVIRONMENT_URL,
    ]);
  });

  test("没有项目产物（没选天空盒 / 占位资产 hdrPath 为 null）时只剩默认那张", () => {
    // 这就是真实症状的那条路：three 侧一直有 `/env/sky.exr` 兜底，PC 侧此前直接 return
    expect(environmentCandidates(null)).toEqual([DEFAULT_ENVIRONMENT_URL]);
    expect(environmentCandidates(undefined)).toEqual([DEFAULT_ENVIRONMENT_URL]);
    expect(environmentCandidates("")).toEqual([DEFAULT_ENVIRONMENT_URL]);
  });

  test("项目产物就等于兜底时不重复（避免白读两遍同一张图）", () => {
    expect(environmentCandidates(DEFAULT_ENVIRONMENT_URL)).toEqual([DEFAULT_ENVIRONMENT_URL]);
  });

  test("兜底也是空表时返回空表（调用方必须能处理「没有候选」）", () => {
    expect(environmentCandidates(null, "")).toEqual([]);
  });
});
