import { describe, expect, test } from "bun:test";
import { createPaneGizmos, type GizmoLayer, type GizmoLike } from "./paneGizmo";
import type { TransformMode, TransformSpace } from "../../../widgets/Viewport/transformMode";

/** 假 gizmo：把引擎里我们真正依赖的那几个成员记下来。 */
function fakeGizmo(name: string, log: string[]) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const gizmo = {
    coordSpace: "world",
    snap: true,
    enabled: false,
    nodes: [] as unknown[],
    destroyed: 0,
    attach(nodes: unknown[] | unknown) {
      const list = Array.isArray(nodes) ? nodes : [nodes];
      if (list.length === 0) return;
      this.nodes = list;
      this.enabled = true;
      log.push(`${name}:attach(${list.length})`);
    },
    detach() {
      this.nodes = [];
      this.enabled = false;
      log.push(`${name}:detach`);
    },
    destroy() { this.destroyed += 1; log.push(`${name}:destroy`); },
    on(event: string, callback: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
    },
    fire(event: string) { for (const callback of listeners.get(event) ?? []) callback(); },
  };
  return gizmo as GizmoLike & { nodes: unknown[]; destroyed: number; fire(event: string): void };
}

function fixture(options: { camera?: boolean; onDragStart?: (paneId: string) => void; onDragEnd?: (paneId: string) => void } = {}) {
  const log: string[] = [];
  const created: GizmoLayer[] = [];
  const removed: GizmoLayer[] = [];
  const gizmos = new Map<string, ReturnType<typeof fakeGizmo>>();
  let nextLayerId = 11;
  const createLayer = (paneId: string): GizmoLayer => {
    const layer: GizmoLayer = { id: nextLayerId++, layer: { name: `gizmo:${paneId}` } };
    created.push(layer);
    log.push(`layer(${paneId})`);
    return layer;
  };
  const handlePromise = createPaneGizmos({
    createLayer,
    removeLayer: (layer) => { removed.push(layer); log.push(`removeLayer(${layer.id})`); },
    cameraFor: (paneId) => (options.camera === false ? null : { name: `camera:${paneId}` }),
    onDragStart: options.onDragStart,
    onDragEnd: options.onDragEnd,
    createGizmos: (_camera, _layer, paneId) => {
      const made = {
        translate: fakeGizmo(`${paneId}:translate`, log),
        rotate: fakeGizmo(`${paneId}:rotate`, log),
        scale: fakeGizmo(`${paneId}:scale`, log),
      };
      for (const [mode, gizmo] of Object.entries(made)) gizmos.set(`${paneId}:${mode}`, gizmo);
      return made;
    },
  });
  return {
    handlePromise, log, created, removed, gizmos,
    get: (paneId: string, mode: TransformMode) => gizmos.get(`${paneId}:${mode}`)!,
    fire: (paneId: string, mode: TransformMode, event: string) => gizmos.get(`${paneId}:${mode}`)!.fire(event),
  };
}

describe("逐窗格变换 gizmo 宿主", () => {
  test("第一次用到某一格才建层与三个 gizmo（不挂就不分配）", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    expect(f.created).toEqual([]);
    handle.setMode("pane-0", "translate");
    expect(f.created.map((layer) => layer.id)).toEqual([11]);
    expect(handle.layerIdFor("pane-0")).toBe(11);
    expect(handle.layerIdFor("pane-1")).toBeNull();
    // 三种模式各一个实例
    expect(f.get("pane-0", "rotate")).toBeDefined();
    expect(f.get("pane-0", "scale")).toBeDefined();
  });

  test("相机还没建好时不建层（下一帧再挂）", async () => {
    const f = fixture({ camera: false });
    const handle = await f.handlePromise;
    handle.setMode("pane-0", "translate");
    handle.attach("pane-0", { name: "box" });
    expect(f.created).toEqual([]);
    expect(handle.modeFor("pane-0")).toBeNull();
    expect(handle.attachedEntity("pane-0")).toBeNull();
  });

  test("挂到实体只挂当前模式，换模式时把旧的摘掉（否则两套手柄叠着）", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    const box = { name: "box" };
    handle.setMode("pane-0", "translate");
    handle.attach("pane-0", box);
    expect(f.get("pane-0", "translate").nodes).toEqual([box]);
    expect(f.get("pane-0", "rotate").nodes).toEqual([]);

    handle.setMode("pane-0", "rotate");
    expect(f.log).toContain("pane-0:translate:detach");
    expect(f.get("pane-0", "rotate").nodes).toEqual([box]);
    expect(f.get("pane-0", "scale").nodes).toEqual([]);
    expect(handle.modeFor("pane-0")).toBe("rotate");
  });

  test("attach(null) 就是摘掉；没有节点时手柄自己也不会 enabled（引擎行为，这里断言不挂错）", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    handle.setMode("pane-0", "translate");
    handle.attach("pane-0", { name: "box" });
    handle.attach("pane-0", null);
    expect(handle.attachedEntity("pane-0")).toBeNull();
    expect(f.get("pane-0", "translate").nodes).toEqual([]);
  });

  test("坐标系切到 local 会落到当前模式（三种模式各自独立实例）", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    handle.setMode("pane-0", "scale");
    handle.setSpace("pane-0", "local");
    expect(handle.spaceFor("pane-0")).toBe("local");
    expect(f.get("pane-0", "scale").coordSpace).toBe("local");
    // 换模式后新的那个也要带上当前坐标系
    handle.setMode("pane-0", "translate");
    expect(f.get("pane-0", "translate").coordSpace).toBe("local");
  });

  test("吸附一律关掉（three 侧三个 snap 都是 null，手感要一致）", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    handle.setMode("pane-0", "translate");
    for (const mode of ["translate", "rotate", "scale"] as TransformMode[]) {
      expect(f.get("pane-0", mode).snap).toBe(false);
    }
  });

  test("拖动开始/结束来自引擎自己的 transform:start/end，并逐格上报", async () => {
    const events: string[] = [];
    const f = fixture({
      onDragStart: (paneId) => events.push(`start:${paneId}`),
      onDragEnd: (paneId) => events.push(`end:${paneId}`),
    });
    const handle = await f.handlePromise;
    handle.setMode("pane-1", "translate");
    expect(handle.dragging("pane-1")).toBe(false);
    f.fire("pane-1", "translate", "transform:start");
    expect(handle.dragging("pane-1")).toBe(true);
    // 别的窗格不受影响（输入层是按格问的）
    expect(handle.dragging("pane-0")).toBe(false);
    f.fire("pane-1", "translate", "transform:end");
    expect(handle.dragging("pane-1")).toBe(false);
    expect(events).toEqual(["start:pane-1", "end:pane-1"]);
  });

  test("dispose 销毁三个 gizmo 并**自己删层**（引擎的 destroy 不管层）", async () => {
    const f = fixture();
    const handle = await f.handlePromise;
    handle.setMode("pane-0", "translate");
    handle.setMode("pane-1", "rotate");
    handle.dispose();
    expect(f.removed.map((layer) => layer.id)).toEqual([11, 12]);
    for (const id of ["pane-0", "pane-1"]) {
      for (const mode of ["translate", "rotate", "scale"] as TransformMode[]) {
        expect(f.get(id, mode).destroyed).toBe(1);
      }
    }
    // dispose 之后不再建层（幂等、也不复活）
    handle.setMode("pane-0", "translate");
    expect(f.created.length).toBe(2);
  });
});

describe("坐标系枚举", () => {
  test("只用 transformMode.ts 里的两种取值（纯契约，不要在渲染层另造一套）", () => {
    const spaces: TransformSpace[] = ["world", "local"];
    expect(spaces).toEqual(["world", "local"]);
  });
});
