import { describe, expect, test } from "bun:test";
import {
  createEditorGrid, DEFAULT_GRID_PARAMS, GRID_FADE_DISTANCE, GRID_FRAGMENT_WGSL, GRID_SECTION_SIZE,
  GRID_SIZE, gridFade, gridFragmentWgsl, gridLineMask, gridParamsKey,
  type GridEntityLike, type ShaderMaterialLike,
} from "./paneGrid";

describe("网格线的覆盖度（与 WGSL 同式的参考实现）", () => {
  // 注意：覆盖度是 min(dx, dz)——**两条线族**取更近的那条。所以要测"离 x 方向的线多远"，
  // z 必须落在两条 z 线正中（半格），否则 z 上的线会把覆盖度顶满。
  const halfCellZ = (size: number) => size / 2;

  test("粗线（thickness=1）：线上覆盖度 1，离一格就归零", () => {
    // 线在 size 的整数倍上：0、5、10…
    expect(gridLineMask(0, 0, 5, 1, 0.01)).toBe(1);
    expect(gridLineMask(5, 0, 5, 1, 0.01)).toBe(1);
    expect(gridLineMask(-5, halfCellZ(5), 5, 1, 0.01)).toBe(1);
    // 一格正中：离最近一条线 2.5 世界单位 = 0.5 格 → 远超 1 像素宽 → 完全归零
    expect(gridLineMask(2.5, halfCellZ(5), 5, 1, 0.01)).toBe(0);
  });

  test("细线（thickness=0.5）最亮只有 0.5，而且比粗线窄一半", () => {
    expect(gridLineMask(0, 0, 0.5, 0.5, 0.01)).toBe(0.5);
    // 离线上 0.25 像素（d=0.25）时：细线 0.25、粗线 0.75——粗线更宽更亮
    expect(gridLineMask(0.25 * 0.01 * 0.5, halfCellZ(0.5), 0.5, 0.5, 0.01)).toBeCloseTo(0.25, 6);
    expect(gridLineMask(0.25 * 0.01 * 5, halfCellZ(5), 5, 1, 0.01)).toBeCloseTo(0.75, 6);
  });

  test("抗锯齿靠屏幕空间导数：导数越大（一个像素跨越多格），同一点越亮", () => {
    // 离线上 0.05 格
    const world = 0.05 * 5;
    const z = halfCellZ(5);
    const sharp = gridLineMask(world, z, 5, 1, 0.01); // 一个像素 = 0.01 格 → 离线 5 像素
    const blurry = gridLineMask(world, z, 5, 1, 0.5); // 一个像素 = 0.5 格 → 离线 0.1 像素
    expect(sharp).toBe(0);
    expect(blurry).toBeGreaterThan(0.8);
  });

  test("负坐标不会算错（JS 的 % 对负数取负，fract 不是）", () => {
    // -0.25 离 0 号线的距离与 +0.25 相同
    expect(gridLineMask(-0.25, 0, 5, 1, 1)).toBeCloseTo(gridLineMask(0.25, 0, 5, 1, 1), 12);
  });

  test("退化的 size 返回 0（不产生 NaN）", () => {
    expect(gridLineMask(1, 1, 0, 1, 0.01)).toBe(0);
    expect(Number.isFinite(gridLineMask(1, 1, 5, 1, 0))).toBe(true);
  });
});

describe("距离淡出", () => {
  test("圆心处为 1、到 fadeDistance 归零、中间按 1.5 次幂衰减", () => {
    expect(gridFade(0, 40)).toBe(1);
    expect(gridFade(40, 40)).toBe(0);
    expect(gridFade(80, 40)).toBe(0);
    expect(gridFade(20, 40)).toBeCloseTo(0.5 ** 1.5, 12);
    // 单调不增
    const samples = [0, 5, 10, 20, 30, 39, 40].map((d) => gridFade(d, 40));
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
  });

  test("fadeDistance 非正时返回 0（不是 NaN）", () => {
    expect(gridFade(1, 0)).toBe(0);
    expect(gridFade(1, -5)).toBe(0);
  });
});

describe("常量与着色器文本", () => {
  test("粗线间距是细线的整数倍（否则两组线互相踩）；默认值与 three 侧一致", () => {
    expect(GRID_SIZE).toBe(400);
    expect(DEFAULT_GRID_PARAMS.cellSize).toBe(0.5);
    expect(DEFAULT_GRID_PARAMS.sectionSize).toBe(5);
    expect(DEFAULT_GRID_PARAMS.fadeDistance).toBe(GRID_FADE_DISTANCE);
    expect(GRID_SECTION_SIZE % DEFAULT_GRID_PARAMS.cellSize).toBe(0);
  });

  test("WGSL 里的公式与参考实现同式（防两处公式漂移）", () => {
    // 两级线、导数归一化、1.5 次幂淡出、两色、透明度公式
    expect(GRID_FRAGMENT_WGSL).toContain("fwidth(p)");
    expect(GRID_FRAGMENT_WGSL).toContain("pow(");
    expect(GRID_FRAGMENT_WGSL).toContain("1.5");
    expect(GRID_FRAGMENT_WGSL).toContain("mix(0.75, 1.0, sections)");
    expect(GRID_FRAGMENT_WGSL).toContain("0.10196078"); // #1a1a1a
    expect(GRID_FRAGMENT_WGSL).toContain("vec3f(0.2, 0.2, 0.2)"); // #333333
    // 淡出圆心必须是**逐相机**的标准 uniform（在 view UB 里），不能烘成常量
    expect(GRID_FRAGMENT_WGSL).toContain("uniform view_position: vec3f;");
  });

  test("参数烘进源码：不同参数生成不同 WGSL 与不同 uniqueName 指纹", () => {
    const custom = gridFragmentWgsl({ cellSize: 2, sectionSize: 20, fadeDistance: 100 });
    expect(custom).toContain("const CELL_SIZE: f32 = 2.0;");
    expect(custom).toContain("const SECTION_SIZE: f32 = 20.0;");
    expect(custom).toContain("const FADE_DISTANCE: f32 = 100.0;");
    // 大数值也要是合法 f32 字面量（不能写成 1e6 那种）
    expect(gridFragmentWgsl({ cellSize: 0.5, sectionSize: 1e6, fadeDistance: 40 })).toContain("const SECTION_SIZE: f32 = 1000000.0;");
    expect(gridParamsKey({ cellSize: 0.5, sectionSize: 5, fadeDistance: 40 }))
      .not.toBe(gridParamsKey({ cellSize: 1, sectionSize: 5, fadeDistance: 40 }));
  });
});

describe("建网格的句柄（注入假实体/假材质）", () => {
  function fixture() {
    const calls: { parameters: [string, unknown][]; updates: number; destroyed: number; entityDestroyed: number } = {
      parameters: [], updates: 0, destroyed: 0, entityDestroyed: 0,
    };
    const created: (ShaderMaterialLike & { sectionSize: number })[] = [];
    const base = {
      blendType: -1, depthWrite: true, cull: -1, sectionSize: 0,
      setParameter: (name: string, value: unknown) => { calls.parameters.push([name, value]); },
      update: () => { calls.updates += 1; },
      destroy: () => { calls.destroyed += 1; },
    };
    const meshInstances = [{ pick: true }, { pick: true }];
    const entity: GridEntityLike = {
      render: { meshInstances, material: null },
      addComponent: () => {},
      setLocalScale: () => {},
      setEulerAngles: () => {},
      destroy: () => { calls.entityDestroyed += 1; },
    };
    const added: unknown[] = [];
    const app = { root: { addChild: (child: unknown) => { added.push(child); } } };
    const createMaterial = (params: { sectionSize: number }) => {
      const made = { ...base, sectionSize: params.sectionSize, destroy: () => { calls.destroyed += 1; } };
      created.push(made);
      return made;
    };
    return { calls, created, createMaterial, entity, meshInstances, added, app };
  }

  test("默认参数下建好网格、挂到 root 上", async () => {
    const f = fixture();
    const grid = await createEditorGrid(f.app, {
      createMaterial: f.createMaterial,
      createEntity: () => f.entity,
    });
    expect(grid.params()).toEqual({ cellSize: 0.5, sectionSize: 5, fadeDistance: 40 });
    expect(f.added).toEqual([f.entity]);
    expect(f.created.length).toBe(1);
  });

  test("setParams 只覆盖传进来的项，并且**换一份材质**（参数是烘进源码的）", async () => {
    const f = fixture();
    const grid = await createEditorGrid(f.app, { createMaterial: f.createMaterial, createEntity: () => f.entity });
    await grid.setParams({ sectionSize: 1 });
    expect(grid.params()).toEqual({ cellSize: 0.5, sectionSize: 1, fadeDistance: 40 });
    expect(f.created.length).toBe(2);
    expect(f.created.at(-1)!.sectionSize).toBe(1);
    // 旧材质被销毁，新材质挂到了实体上
    expect(f.calls.destroyed).toBe(1);
    expect(f.entity.render!.material).toBe(f.created.at(-1));
    // 参数没变就不重建
    await grid.setParams({ sectionSize: 1 });
    expect(f.created.length).toBe(2);
  });

  test("**每个 mesh instance 的 pick 都被关掉**（否则 400×400 的平面吃掉所有点击）", async () => {
    const f = fixture();
    const grid = await createEditorGrid(f.app, { createMaterial: f.createMaterial, createEntity: () => f.entity });
    expect(grid.meshInstanceCount()).toBe(2);
    expect(grid.pickableMeshInstanceCount()).toBe(0);
    expect(f.meshInstances.every((instance) => instance.pick === false)).toBe(true);
  });

  test("dispose 同时销毁实体与材质", async () => {
    const f = fixture();
    const grid = await createEditorGrid(f.app, { createMaterial: f.createMaterial, createEntity: () => f.entity });
    grid.dispose();
    expect(f.calls.entityDestroyed).toBe(1);
    expect(f.calls.destroyed).toBe(1);
  });
});
