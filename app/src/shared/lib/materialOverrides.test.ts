import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { MATERIAL_TEXTURE_SLOTS, type AssetMaterial } from "./libraryApi";
import {
  collectSupportedSlots,
  DEFAULT_MATERIAL,
  isDefaultMaterial,
  normalizeMaterial,
  SLOT_LABELS,
} from "./materialOverrides";

/**
 * 材质覆盖只剩"换贴图"这一件事，所以要钉住的就是：默认值判得准（决定视口跳不跳过覆盖）、
 * 旧记录收敛得动、以及通道列表按真实材质收窄（否则会摆出永远不生效的槽位）。
 */

function rootWith(material: THREE.Material): THREE.Object3D {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  return root;
}

describe("isDefaultMaterial", () => {
  test("没有记录、空记录、以及全是 undefined 的槽位都算默认", () => {
    expect(isDefaultMaterial(undefined)).toBe(true);
    expect(isDefaultMaterial(DEFAULT_MATERIAL)).toBe(true);
    expect(isDefaultMaterial({ textures: {} })).toBe(true);
    expect(isDefaultMaterial({ textures: { map: undefined } })).toBe(true);
  });

  test("只要有一个通道被换成具体路径就不是默认", () => {
    expect(isDefaultMaterial({ textures: { map: "projects/p/source/1-ref.png" } })).toBe(false);
  });
});

describe("normalizeMaterial", () => {
  test("缺失记录给默认值，缺失 textures 收敛成空表", () => {
    expect(normalizeMaterial(undefined)).toBe(DEFAULT_MATERIAL);
    expect(normalizeMaterial({ textures: undefined as never })).toEqual({ textures: {} });
  });

  test("旧记录里残留的 shader 键被丢掉，只留贴图", () => {
    const legacy = { shader: "wireframe", textures: { map: "projects/p/source/1.png" } };
    expect(normalizeMaterial(legacy as unknown as AssetMaterial)).toEqual({
      textures: { map: "projects/p/source/1.png" },
    });
  });
});

describe("SLOT_LABELS", () => {
  test("每个可覆盖通道都有展示名", () => {
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      expect(SLOT_LABELS[slot]).toBeTruthy();
    }
  });
});

describe("collectSupportedSlots", () => {
  test("standard/physical 认全部 PBR 通道", () => {
    for (const material of [new THREE.MeshStandardMaterial(), new THREE.MeshPhysicalMaterial()]) {
      const supported = collectSupportedSlots(rootWith(material));
      expect([...supported].sort()).toEqual([...MATERIAL_TEXTURE_SLOTS].sort());
    }
  });

  test("phong 收窄掉 roughness/metalness，保留它真正读的通道", () => {
    const supported = collectSupportedSlots(rootWith(new THREE.MeshPhongMaterial()));
    expect([...supported].sort()).toEqual(
      ["alphaMap", "aoMap", "emissiveMap", "map", "normalMap"],
    );
  });

  test("basic 只认 map/aoMap/alphaMap", () => {
    const supported = collectSupportedSlots(rootWith(new THREE.MeshBasicMaterial()));
    expect([...supported].sort()).toEqual(["alphaMap", "aoMap", "map"]);
  });

  test("多材质取并集：任一部件声明过的通道都算支持", () => {
    const root = rootWith(new THREE.MeshPhongMaterial());
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    expect([...collectSupportedSlots(root)].sort()).toEqual([...MATERIAL_TEXTURE_SLOTS].sort());
  });

  test("非网格节点不参与判断", () => {
    const root = rootWith(new THREE.MeshPhongMaterial());
    root.add(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
    expect(collectSupportedSlots(root).has("roughnessMap")).toBe(false);
  });
});
