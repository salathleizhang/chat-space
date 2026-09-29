import { useGLTF } from "@react-three/drei/core/Gltf";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import type { WorldSemantics } from "../../shared/lib/libraryApi";
import { worldTransform } from "./worldTransform";
import { useModelResource } from "../../shared/rendering/useModelResource";
import { disposeSkeletons } from "../../shared/rendering/ModelResources";

/**
 * world 的 collider 网格：作为地形线框参照渲染，不参与拾取。
 *
 * World Labs 一个世界返回两套几何——spz 泼溅是"画面"，collider glb 是"物理"。这里把
 * collider 按与泼溅**完全相同**的变换渲染成线框（同一份 `worldTransform`），让地形起伏
 * 可见、便于把模型摆到地面上；这也是 image-blaster 的做法（同一组 flip/scale/offset
 * 同时套在 SplatMesh 与 RigidBody 上）。
 *
 * 线框不会被泼溅遮住：世界泼溅的参照显示路径不写深度缓冲，所以
 * 线框始终可见，同时仍会被会写深度的模型正确遮挡，正好是"参照层"该有的行为。
 */

/** 关掉拾取：参照层不该抢走模型点选 */
const ignoreRaycast: THREE.Object3D["raycast"] = () => {};

const COLLIDER_COLOR = 0xffffff;
const COLLIDER_OPACITY = 0.22;

export default function WorldColliderMesh({
  url,
  semantics,
}: {
  url: string;
  semantics: WorldSemantics;
}) {
  const { scene } = useGLTF(url);
  useModelResource(scene, () => useGLTF.clear(url));
  const transform = useMemo(() => worldTransform(semantics), [semantics]);

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: COLLIDER_COLOR,
        wireframe: true,
        transparent: true,
        opacity: COLLIDER_OPACITY,
        // 只当参照：不写深度，免得跟后面渲染的东西互相打架
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  /*
    useGLTF 的场景是按 URL 共享的缓存对象，直接改材质会污染其他消费者（模型列表的
    缩略图渲染走同一个缓存），所以克隆一份再改。几何体仍与缓存共享，不能 dispose。
  */
  const model = useMemo(() => {
    const cloned = SkeletonUtils.clone(scene);
    cloned.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.material = material;
      child.raycast = ignoreRaycast;
      child.castShadow = false;
      child.receiveShadow = false;
      // Transparent sorting by object center can put terrain before the splats.
      // Draw the reference layer afterwards while still testing opaque depth.
      child.renderOrder = 2;
    });
    return cloned;
  }, [scene, material]);
  useEffect(() => () => disposeSkeletons(model), [model]);

  return (
    <group position={transform.position} rotation={transform.rotation} scale={transform.scale}>
      <primitive object={model} dispose={null} />
    </group>
  );
}
