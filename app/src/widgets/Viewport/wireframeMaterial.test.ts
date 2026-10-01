import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  applyWireframe,
  createWireframeMaterial,
  restoreWireframe,
  wireframeMaterial,
} from "./wireframeMaterial";

/**
 * 线框着色的全部真实逻辑都在这三个纯函数里（换材质、还原、共享单例），外层 hook 只负责
 * 在开关变化时调用它们并要一帧。三类必错项：把线框材质套到不该套的节点上（选中包围盒本身
 * 就是 LineSegments）、还原不干净或还原错实例、以及把共享单例当成"自己造的"给 dispose 掉。
 */

function makeScene() {
  const meshMaterial = new THREE.MeshStandardMaterial({ color: 0x336699 });
  const multiMaterials = [
    new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
  ];
  const group = new THREE.Group();
  // 材质写成宽类型：被测的是"换掉了没有 / 还回去的是不是同一个实例"，
  // 让 `mesh.material` 推成 MeshStandardMaterial 反而会让断言比不出 MeshBasicMaterial
  const mesh: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(), meshMaterial);
  const multi: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(), multiMaterials);
  // 选中包围盒就是 LineSegments，它自己已经是线了，不该被再换一次
  const highlight = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry()));
  const points = new THREE.Points(new THREE.BufferGeometry());
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
  group.add(mesh, multi, highlight, points, sprite);
  return { group, mesh, multi, highlight, points, sprite, meshMaterial, multiMaterials };
}

describe("createWireframeMaterial", () => {
  test("线框透视渲染的四个开关都按文档设好", () => {
    const material = createWireframeMaterial();
    expect(material.wireframe).toBe(true);
    // 背面棱也要看得见（Blender 的线框模式是透视的）
    expect(material.depthTest).toBe(false);
    // 写深度：否则排在透明队列里的泼溅背景会整片压在线框上
    expect(material.depthWrite).toBe(true);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.toneMapped).toBe(false);
    material.dispose();
  });

  test("共享单例只造一次，且与单测自造的那份是两个实例", () => {
    expect(wireframeMaterial()).toBe(wireframeMaterial());
    const own = createWireframeMaterial();
    expect(own).not.toBe(wireframeMaterial());
    own.dispose();
  });
});

describe("applyWireframe", () => {
  test("每个网格都换成共享的那份线框材质，并记下原材质", () => {
    const { group, mesh, multi, meshMaterial, multiMaterials } = makeScene();
    const applied = applyWireframe(group);

    expect(applied.meshes).toHaveLength(2);
    expect(mesh.material).toBe(wireframeMaterial());
    expect(multi.material).toBe(wireframeMaterial());
    // 记下的必须是**原实例**（含多材质数组本身），不是克隆体
    expect(applied.meshes[0]!.original).toBe(meshMaterial);
    expect(applied.meshes[1]!.original).toBe(multiMaterials);
  });

  test("LineSegments / Points / Sprite 一个都不碰", () => {
    const { group, highlight, points, sprite } = makeScene();
    const highlightMaterial = highlight.material;
    const pointsMaterial = points.material;
    const spriteMaterial = sprite.material;

    applyWireframe(group);

    expect(highlight.material).toBe(highlightMaterial);
    expect(points.material).toBe(pointsMaterial);
    expect(sprite.material).toBe(spriteMaterial);
  });

  test("空的克隆体（还没加载出网格）返回空表而不是抛错", () => {
    const applied = applyWireframe(new THREE.Group());
    expect(applied.meshes).toEqual([]);
  });
});

describe("restoreWireframe", () => {
  test("把原实例整体还回去，多材质数组也是同一个引用", () => {
    const { group, mesh, multi, meshMaterial, multiMaterials } = makeScene();
    const applied = applyWireframe(group);

    restoreWireframe(applied);

    expect(mesh.material).toBe(meshMaterial);
    expect(multi.material).toBe(multiMaterials);
  });

  test("还原不 dispose 任何材质——线框材质是共享单例，原材质归 loader 缓存管", () => {
    const { group, mesh, meshMaterial } = makeScene();
    let wireframeDisposed = false;
    let originalDisposed = false;
    wireframeMaterial().addEventListener("dispose", () => { wireframeDisposed = true; });
    meshMaterial.addEventListener("dispose", () => { originalDisposed = true; });

    const applied = applyWireframe(group);
    restoreWireframe(applied);

    expect(wireframeDisposed).toBe(false);
    expect(originalDisposed).toBe(false);
    // 还原后还能继续用（说明没被 dispose 掉）
    expect(mesh.material).toBe(meshMaterial);
  });

  test("网格上挂的已经不是线框材质时不覆盖（幂等，且让另一写入方赢）", () => {
    const { group, mesh } = makeScene();
    const applied = applyWireframe(group);
    const otherWriter = new THREE.MeshBasicMaterial();

    mesh.material = otherWriter;
    restoreWireframe(applied);

    expect(mesh.material).toBe(otherWriter);
    otherWriter.dispose();
  });

  test("重复还原是幂等的", () => {
    const { group, mesh, meshMaterial } = makeScene();
    const applied = applyWireframe(group);

    restoreWireframe(applied);
    restoreWireframe(applied);

    expect(mesh.material).toBe(meshMaterial);
  });
});
