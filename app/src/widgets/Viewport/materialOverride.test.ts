import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import type { MaterialTextureSlot } from "../../shared/lib/libraryApi";
import { applyOverride, createOverrideMaterial, restoreOverride } from "./materialOverride";

/**
 * 覆盖的全部真实逻辑都在这一层：克隆原材质、只补被替换的通道、还原时把原件还回去。
 * 外层 hook 只负责异步取图和要帧，而贴图加载在 happy-dom 里跑不动（`<img>` 永不回调），
 * 所以这里直接喂手工构造的贴图表——这也正好是能出错的那些地方。
 *
 * 三类必错项：改到 loader 缓存里的原件（污染预览窗/悬浮卡）、克隆时丢掉原材质的贴图、
 * 以及还原不干净（留下半覆盖状态或泄漏自己造的实例）。
 */

function makeScene() {
  const sourceMap = new THREE.Texture();
  sourceMap.flipY = false;
  const source = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.2, 0.4, 0.6),
    map: sourceMap,
    roughness: 0.25,
    metalness: 0.75,
    transparent: true,
    opacity: 0.5,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
  const group = new THREE.Group();
  group.add(mesh);
  return { group, mesh, source, sourceMap };
}

function replacements(
  pairs: [MaterialTextureSlot, THREE.Texture][],
): Map<MaterialTextureSlot, THREE.Texture> {
  return new Map(pairs);
}

describe("createOverrideMaterial", () => {
  test("克隆原材质并只改被替换的通道，其余贴图与参数原样保留", () => {
    const { source, sourceMap } = makeScene();
    const replacement = new THREE.Texture();
    const target = createOverrideMaterial(source, replacements([["map", replacement]]));

    expect(target).not.toBe(source);
    expect(target.type).toBe(source.type);
    expect((target as THREE.MeshStandardMaterial).map).toBe(replacement);
    // 没被替换的通道与参数必须跟着走，否则换一张 base color 就等于把材质洗白
    expect((target as THREE.MeshStandardMaterial).roughness).toBe(0.25);
    expect((target as THREE.MeshStandardMaterial).metalness).toBe(0.75);
    expect((target as THREE.MeshStandardMaterial).opacity).toBe(0.5);
    expect((target as THREE.MeshStandardMaterial).transparent).toBe(true);
    // 原件的 map 没被动过
    expect(source.map).toBe(sourceMap);
  });

  test("被替换的通道按 sRGB 采样，线性数据通道保持 NoColorSpace", () => {
    const { group } = makeScene();
    const applied = applyOverride(
      group,
      replacements([
        ["map", new THREE.Texture()],
        ["normalMap", new THREE.Texture()],
      ]),
    );
    const material = (applied.meshes[0]!.mesh.material as THREE.MeshStandardMaterial);
    expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    restoreOverride(applied);
  });

  test("新贴图沿用模型自带的 UV 约定（glTF 的 flipY=false 会被抄过来）", () => {
    const { group } = makeScene();
    const applied = applyOverride(group, replacements([["map", new THREE.Texture()]]));
    const material = applied.meshes[0]!.mesh.material as THREE.MeshStandardMaterial;
    expect(material.map?.flipY).toBe(false);
    restoreOverride(applied);
  });
});

describe("applyOverride", () => {
  test("绝不修改 loader 缓存里的原件", () => {
    const { group, source } = makeScene();
    const applied = applyOverride(group, replacements([["map", new THREE.Texture()]]));
    expect(source.map).toBeDefined();
    expect(source.map?.colorSpace).toBe(THREE.NoColorSpace);
    expect(source.map?.flipY).toBe(false);
    restoreOverride(applied);
  });

  test("共用同一原材质的多个网格只造一份覆盖材质", () => {
    const { group, mesh, source } = makeScene();
    const second = new THREE.Mesh(new THREE.BoxGeometry(), source);
    group.add(second);
    const applied = applyOverride(group, replacements([["map", new THREE.Texture()]]));
    const first = mesh.material as THREE.Material;
    expect(second.material as THREE.Material).toBe(first);
    expect(first).not.toBe(source as THREE.Material);
    restoreOverride(applied);
  });

  test("高亮包围盒这类非网格节点不被换材质", () => {
    const { group } = makeScene();
    const lineMaterial = new THREE.LineBasicMaterial();
    group.add(new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial));
    const applied = applyOverride(group, replacements([["map", new THREE.Texture()]]));
    expect(group.children[1]!.type).toBe("LineSegments");
    expect((group.children[1] as THREE.LineSegments).material).toBe(lineMaterial);
    restoreOverride(applied);
  });
});

describe("restoreOverride", () => {
  test("还原成原材质，并释放自己造的那批实例", () => {
    const { group, mesh, source } = makeScene();
    const applied = applyOverride(group, replacements([["map", new THREE.Texture()]]));
    const created = applied.materials[0]!;
    let disposed = 0;
    created.addEventListener("dispose", () => { disposed += 1; });

    restoreOverride(applied);
    expect(mesh.material).toBe(source);
    expect(disposed).toBe(1);
  });
});
