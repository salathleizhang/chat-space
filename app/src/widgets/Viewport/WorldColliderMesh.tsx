import { useGLTF } from "@react-three/drei/core/Gltf";
import { useMemo } from "react";
import * as THREE from "three";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import type { WorldSemantics } from "../../shared/lib/libraryApi";
import { worldTransform } from "./worldTransform";
import { useModelResource } from "../../shared/rendering/useModelResource";
import { disposeSkeletons } from "../../shared/rendering/ModelResources";
import { useDeferredDispose } from "../../shared/rendering/useDeferredDispose";

/**
 * world 的 collider 网格：作为地形参照挂进场景（**当前 100% 透明、整颗不画**，见下面的
 * `COLLIDER_VISIBLE`），不参与拾取。
 *
 * World Labs 一个世界返回两套几何——spz 泼溅是"画面"，collider glb 是"物理"。这里把
 * collider 按与泼溅**完全相同**的变换挂进场景（同一份 `worldTransform`），需要时能当地形
 * 参照用；这也是 image-blaster 的做法（同一组 flip/scale/offset 同时套在 SplatMesh 与
 * RigidBody 上）。
 *
 * GLB 本身照旧下载、解析、挂在场景里（资产保留，chat 侧采地面高度读的是同一个文件），
 * 只是**一个像素都不画**。
 */

/** 关掉拾取：参照层不该抢走模型点选 */
const ignoreRaycast: THREE.Object3D["raycast"] = () => {};

const COLLIDER_COLOR = 0xffffff;
/**
 * 参照层的不透明度（只有把 `COLLIDER_VISIBLE` 翻回 `true` 时才用得上）。
 * 它是**整片半透明面**，不是线框：线框只盖住细线，同样的 alpha 摊到整片面上会白得多，
 * 所以这里比原来线框的 0.22 低。想更淡/更明显就改这一个数。
 */
const COLLIDER_OPACITY = 0.12;

/**
 * 要不要画这层地形参照。**默认 `false` = 100% 透明（看不见）**。
 *
 * 100% 透明**不要用 `opacity: 0`**：那仍然会进透明队列，每帧把 collider 的几十万面光栅化
 * 一遍再乘 0，纯白付填充 + blending 的钱。`visible = false` 是 three 的整棵子树早退
 * （`three.webgpu.js` 的 `_projectObject` 第一行就 `if (object.visible === false) return;`，
 * 子节点根本不会被遍历），一次绘制都不提交。
 */
const COLLIDER_VISIBLE = false;

/**
 * 参照材质没有任何参数，做成模块级单例：省掉每次挂载重建，也消掉原来那个 StrictMode 陷阱
 * （`useMemo` 建 + effect cleanup `dispose()` → 回放时释放的正是**在用**的那一份，见
 * `DeferredResource` 的注释）。
 *
 * 透明渲染的写法与 `WebGPUGrid` 一致：`transparent` + `depthWrite: false` + `DoubleSide`。
 * **`depthWrite` 必须保持 `false`**：写了深度，参照层后面的泼溅就会被深度测试剔掉，
 * 变成"墙后面什么都没有"，那就不是透明墙了。
 */
const colliderMaterial = new THREE.MeshBasicMaterial({
  color: COLLIDER_COLOR,
  transparent: true,
  opacity: COLLIDER_OPACITY,
  // 透明墙两面都看得见：collider 是一层很薄的壳，只留正面会在下方机位整片消失
  side: THREE.DoubleSide,
  // 只当参照：不写深度，免得跟后面渲染的东西互相打架
  depthWrite: false,
  toneMapped: false,
  fog: false,
});
colliderMaterial.name = "world-collider";

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
  const material = colliderMaterial;

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
  // 延迟一个 macrotask 再释放骨架：StrictMode 回放会在同一轮里 cleanup → 重新挂载，
  // 立即释放会拆掉正在渲染的那一份。
  useDeferredDispose(model, disposeSkeletons);

  return (
    <group
      visible={COLLIDER_VISIBLE}
      position={transform.position}
      rotation={transform.rotation}
      scale={transform.scale}
    >
      <primitive object={model} dispose={null} />
    </group>
  );
}
