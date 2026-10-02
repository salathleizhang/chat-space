import { describe, expect, test } from "bun:test";
import { LAYERID_SKYBOX } from "playcanvas";
import { buildPaneBindings, PANE_SHARED_LAYER_IDS, type PaneEngineApi } from "./enginePanes";
import { cameraLayers } from "./paneRegistry";

/**
 * 这里钉的是**接线**，不是数学：真机出现过"引擎状态 `hasSkybox: true`、Sky 层有 mesh、
 * 画面背景却是纯黑"——原因是 `PaneRegistry.sync()` 用 `cameraLayers(...)` 重写相机 layers 时，
 * 引擎的 Skybox 层（id 2）没被列进来，被层过滤挡在画面外。
 * 这一条以前只写在注释里、产品与探针都没有接线，所以要有测试守着。
 */

/** 假引擎：只提供 `buildPaneBindings` 真正会用到的那几样。 */
function fakeEngine(): PaneEngineApi {
  class FakeColor {
    constructor(public r: number, public g: number, public b: number) {}
  }
  class FakeVec4 {
    constructor(public x: number, public y: number, public z: number, public w: number) {}
  }
  class FakeLayer {
    static counter = 5;
    id: number;
    constructor(public options: { name: string }) { this.id = FakeLayer.counter++; }
  }
  class FakeEntity {
    camera?: Record<string, unknown>;
    constructor(public name: string) {}
    addComponent(type: string) { if (type === "camera") this.camera = {}; }
    destroy() {}
  }
  return {
    Entity: FakeEntity as unknown as PaneEngineApi["Entity"],
    Layer: FakeLayer as unknown as PaneEngineApi["Layer"],
    Vec4: FakeVec4 as unknown as PaneEngineApi["Vec4"],
    Color: FakeColor as unknown as PaneEngineApi["Color"],
    PROJECTION_PERSPECTIVE: 0,
    PROJECTION_ORTHOGRAPHIC: 1,
  };
}

function fakeApp() {
  const pushed: unknown[] = [];
  return {
    root: { addChild: () => {} },
    scene: { layers: { push: (layer: unknown) => { pushed.push(layer); }, remove: () => {} } },
    pushed,
  };
}

const canvas = { clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement;

describe("引擎绑定：每格相机 must-see 的场景级层", () => {
  test("常量就是引擎的 Skybox 层（值是 2，不是我们自己的编号）", () => {
    expect(LAYERID_SKYBOX).toBe(2);
    expect(PANE_SHARED_LAYER_IDS).toContain(LAYERID_SKYBOX);
  });

  test("绑定对象把它交给 PaneRegistry（产品与探针都是从这一处拿的）", () => {
    const bindings = buildPaneBindings(fakeEngine(), canvas, fakeApp());
    expect(bindings.sharedLayerIds).toEqual(PANE_SHARED_LAYER_IDS);
    expect(bindings.sharedLayerIds).toContain(LAYERID_SKYBOX);
  });

  test("它确实进得了 camera.layers（不是只挂在选项上）", () => {
    const layers = cameraLayers(0, 5, [7], PANE_SHARED_LAYER_IDS);
    expect(layers).toContain(LAYERID_SKYBOX);
    // 且不挤掉逐格自己的层
    expect(layers).toContain(0);
    expect(layers).toContain(5);
    expect(layers).toContain(7);
  });

  test("相机与逐格 HUD 层照旧工作（顺手确认这次重构没动到它们）", () => {
    const app = fakeApp();
    const bindings = buildPaneBindings(fakeEngine(), canvas, app);
    const handle = bindings.createCamera("pane-0");
    handle.applyCamera({
      rect: { x: 0, y: 0, z: 1, w: 1 },
      layers: cameraLayers(0, 5, [], bindings.sharedLayerIds ?? []),
      priority: 0,
      clearColorBuffer: true,
      clearDepthBuffer: true,
      projection: "perspective",
      fov: 60,
      orthoHeight: 7.5,
    });
    const layerId = bindings.createPaneLayer!("pane-0");
    expect(layerId).toBeGreaterThanOrEqual(5);
    expect(app.pushed).toHaveLength(1);
    bindings.dispose();
  });
});
