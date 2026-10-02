import { describe, expect, test } from "bun:test";
import {
  applyWireframeShading, collectMeshInstances, restoreWireframeShading,
} from "./wireframeShading";

const mesh = (renderStyle: number) => ({ renderStyle });
interface FakeEntity {
  render: { meshInstances: { renderStyle: number | undefined }[] };
  children: FakeEntity[];
}
const SOLID = 0;
const WIRE = 1;
const entity = (styles: number[], children: FakeEntity[] = []): FakeEntity => ({
  render: { meshInstances: styles.map((style) => mesh(style)) },
  children,
});

describe("线框着色的换/还", () => {
  test("遍历实体树：自己 + 子实体的 mesh instance 都收到", () => {
    const child = entity([SOLID]);
    const root = entity([SOLID, WIRE], [child, null as unknown as FakeEntity, { children: [entity([SOLID])] } as FakeEntity]);
    expect(collectMeshInstances([root]).length).toBe(4);
  });

  test("换成线框、再还回来（含子实体）", () => {
    const root = entity([SOLID], [entity([SOLID])]);
    const saved = new Map();
    expect(applyWireframeShading([root], WIRE, saved)).toBe(2);
    expect(root.render.meshInstances[0]!.renderStyle).toBe(WIRE);
    expect(root.children[0]!.render.meshInstances[0]!.renderStyle).toBe(WIRE);
    expect(restoreWireframeShading(saved)).toBe(2);
    expect(root.render.meshInstances[0]!.renderStyle).toBe(SOLID);
    expect(root.children[0]!.render.meshInstances[0]!.renderStyle).toBe(SOLID);
    expect(saved.size).toBe(0);
  });

  test("**连开两次**再关：原材质必须是第一次那个（记账别被覆盖）", () => {
    const root = entity([SOLID]);
    const saved = new Map();
    applyWireframeShading([root], WIRE, saved);
    applyWireframeShading([root], WIRE, saved); // 第二次不该改记账
    expect(saved.get(root.render.meshInstances[0]!)).toBe(SOLID);
    restoreWireframeShading(saved);
    expect(root.render.meshInstances[0]!.renderStyle).toBe(SOLID);
  });

  test("没有 render / 没有 mesh instance 的实体安全跳过", () => {
    const odd = [{}, { render: {} }, { render: { meshInstances: [] } }, { render: { meshInstances: [{ renderStyle: undefined }] } }];
    expect(collectMeshInstances(odd).length).toBe(0);
    expect(applyWireframeShading(odd, WIRE, new Map())).toBe(0);
  });

  test("关掉时不碰没记过账的 mesh（只有模型资产会被换）", () => {
    const grid = entity([SOLID]);
    const root = entity([SOLID]);
    const saved = new Map();
    applyWireframeShading([root], WIRE, saved); // 只对 root 开
    restoreWireframeShading(saved);
    expect(grid.render.meshInstances[0]!.renderStyle).toBe(SOLID);
  });
});