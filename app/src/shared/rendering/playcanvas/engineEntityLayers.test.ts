import { describe, expect, test } from "bun:test";

/**
 * **引擎事实钉子**（这里测的不是本仓库的代码，而是我们依赖的那条引擎行为）。
 *
 * 为什么值得单独钉住：`entity.layers = [id]` 在类型上（我们自己的接口）和运行时**都不报错**，
 * 只是**什么也不做**——这一个 no-op 已经在本仓库造成过两次真实缺陷：
 *  - 坐标轴球 HUD（`paneAxisHud.ts`）：12 个部件留在默认的 World 层 → **4 窗格下从一格能看到
 *    另一格的坐标轴**（用户报的那个 bug）；
 *  - 选中线框（`selectionWireframe.ts`）：同一个形状，线框被深度测试、还每格画一遍。
 *
 * 正确写法是**组件数据**：`entity.addComponent("render", { ..., layers: [id] })`
 * （引擎自己的 `extras/gizmo/mesh-line.js` 就是这么写的），组件已经建好时是
 * `entity.render.layers = [id]`。
 *
 * ⚠️ **引擎升级时这两个断言必须重新跑**：如果哪天 `Entity` 真的有了 `layers`，本文件会失败，
 * 那时要重新确认"层到底归谁管"，而不是简单删掉断言。
 */
describe("PlayCanvas 引擎：层归属只在**组件**上，实体上没有", () => {
  test("GraphNode / Entity 没有 layers 访问器；RenderComponent 有", async () => {
    const pc = await import("playcanvas");
    expect(Object.getOwnPropertyNames(pc.GraphNode.prototype)).not.toContain("layers");
    expect(Object.getOwnPropertyNames(pc.Entity.prototype)).not.toContain("layers");
    expect(Object.getOwnPropertyNames(pc.RenderComponent.prototype)).toContain("layers");
  });

  test("给实体写 layers 只是挂一个**没人读**的自有属性（读得回来，但引擎不看它）", async () => {
    const pc = await import("playcanvas");
    const entity = new pc.Entity("probe") as unknown as { layers?: number[]; render?: unknown };
    expect(entity.layers).toBeUndefined();
    entity.layers = [7];
    // 读得回来：所以"赋值成功"这件事**不能**当作"层生效了"的证据（这就是它为什么静默）
    expect(entity.layers).toEqual([7]);
    expect(Object.prototype.hasOwnProperty.call(entity, "layers")).toBe(true);
    // 它连 render 组件都不会建：真正的层写在 `entity.render.layers` 上
    expect(entity.render).toBeUndefined();
  });

  test("render 组件上的 layers 是可写访问器（数据驱动的 `addComponent(..., { layers })` 走它）", async () => {
    const pc = await import("playcanvas");
    const descriptor = Object.getOwnPropertyDescriptor(pc.RenderComponent.prototype, "layers");
    expect(typeof descriptor?.get).toBe("function");
    expect(typeof descriptor?.set).toBe("function");
    /*
      `addComponent("render", { layers: [...] })` 到底有没有把 mesh 注册进那一层，这里**验不了**：
      组件系统要先有 graphicsDevice（`RenderComponentSystem` 构造时就问它要默认材质）。
      那条判据放在真实浏览器探针里（`panes.browser.ts` 的 `hud=1`：逐格 HUD 层的 meshInstance 数、
      以及 World 层在挂 HUD 前后**不变**）。
    */
  });
});
