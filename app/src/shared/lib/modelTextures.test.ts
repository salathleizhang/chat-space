import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { collectChannelTextures } from "./modelTextures";

/**
 * 右侧栏贴图列表的数据源：某个通道"现在是谁"。它按通道取值，与悬浮卡的"按贴图去重"
 * 正好相反，所以两个函数不能互相替代。
 */

function rootWith(material: THREE.Material): THREE.Object3D {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  return root;
}

describe("collectChannelTextures", () => {
  test("按通道取第一个填了它的材质，没填的通道不出现在结果里", () => {
    const root = rootWith(
      new THREE.MeshStandardMaterial({ map: new THREE.Texture(), normalMap: new THREE.Texture() }),
    );
    const found = collectChannelTextures(root, ["map", "normalMap", "roughnessMap"]);
    expect(found.get("map")).toBeDefined();
    expect(found.get("normalMap")).toBeDefined();
    // 右侧栏据此显示 "Not set"
    expect(found.get("roughnessMap")).toBeUndefined();
  });

  test("非网格节点（如高亮包围盒的线材质）不参与抽取", () => {
    const root = rootWith(new THREE.MeshStandardMaterial({ map: new THREE.Texture() }));
    root.add(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()));
    expect(collectChannelTextures(root, ["map"]).size).toBe(1);
  });
});
