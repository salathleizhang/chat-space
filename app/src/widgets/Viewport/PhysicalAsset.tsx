import { CuboidCollider, RigidBody } from "@react-three/rapier";
import { useRef, type ReactNode } from "react";
import type * as THREE from "three";
import type { AssetTransform } from "../../shared/lib/libraryApi";
import { OBJECT_ANGULAR_DAMPING, OBJECT_LINEAR_DAMPING, boxColliderFromBounds } from "./physics";

/**
 * 一个摆放资产的**物理化身**：刚体 + 盒体碰撞体，包住 `ModelMesh`。
 *
 * 三个关键取舍（每一条都有理由，别顺手改）：
 *
 * 1. **盒体，不是 trimesh。** 本项目真实资产是 40 MB 级、百万三角面的生成模型
 *    （实测 `cream-sofa` 1 487 850 tris、`geometric-rug` 1 400 702 tris），逐个建 trimesh
 *    在浏览器里既慢又吃内存；世界碰撞网格才 4–6 万面，那一份用 trimesh。与 image-blaster 一致。
 *
 * 2. **刚体自己就是"摆放"的持有者。** 它直接吃 `transform`（位置/旋转/缩放），并且
 *    `@react-three/rapier` 会在 `position/rotation` 这些 prop 变化时把刚体 teleport 到
 *    `object.matrixWorld`（`setRigidBodyOptions` 的 `updateTranslations` 分支）。
 *    于是"gizmo 提交 → props 变 → 刚体跟着走"是引擎自己接好的，不需要我们再写一遍。
 *    反过来也别在别处写这个刚体的 transform：物理每帧会把它盖回来。
 *
 * 3. **碰撞体挂在刚体原点，尺寸取包围盒的一半。** 模型的 `<Center>` 已经把包围盒中心
 *    挪到刚体原点，所以碰撞体不需要偏移；`@react-three/rapier` 会用**碰撞体自己的世界缩放**
 *    去缩放 args，于是摆放缩放（`scale`）自然传导，也不会出现"偏移量没跟着缩放"的错位。
 *
 * 刚体创建后**立刻睡眠**：物理世界只在第一人称下推进（见 `PhysicsWorldGate`），
 * 但即便如此，"进入第一人称时全屋家具集体下落"也是不可接受的——睡着 = 没人碰就不动。
 */
export function PhysicalAsset({
  name,
  assetId,
  transform,
  bounds,
  onObject,
  children,
}: {
  /** 与资产 `<group>` 同名的节点名：整场景检查按 `asset:` 前缀取景，改名会让检查图丢内容 */
  name?: string;
  /**
   * 稳定资产 id，写进刚体的 `userData`。
   *
   * 存在的唯一理由是**准星抓取要能反查"抓到的是哪一件"**：rapier 的射线只给碰撞体，
   * 而"抓起来 = 在第三人称选中它"要靠这个 id 回到 `LibraryAsset`（见 `grabSelection.ts`）。
   * 别改成从节点名 `asset:<id>` 里解字符串——名字是给整场景检查取景用的展示字段，
   * 改名的代价不该是"选中失灵"（PC 侧就踩过按名字比身份的坑）。
   */
  assetId: string;
  /** 该资产的摆放（与 `scenePlacement` 同语义：position 是包围盒中心） */
  transform: AssetTransform;
  /** 已渲染模型的**紧**包围盒（局部坐标，未乘摆放缩放）；未加载完时为 null */
  bounds: THREE.Box3 | null;
  /**
   * 把刚体自己的 `Object3D` 交出去。拾取代理、gizmo 轴心、整场景检查都按这个节点算世界变换，
   * 所以它必须就是**摆放的持有者**——物理开着的时候，那个节点不再是 `<group>` 而是刚体本体。
   */
  onObject?: (object: THREE.Object3D | null) => void;
  children: ReactNode;
}) {
  const box = bounds ? boxColliderFromBounds(bounds) : null;
  // 同 ModelMesh：回调身份每次渲染都可能变，但只在建刚体那一次要用
  const reportObject = useRef(onObject);
  reportObject.current = onObject;

  return (
    <RigidBody
      name={name}
      /*
        包围盒没量出来之前**必须是 fixed**：模型是 40 MB 级的 GLB，加载要几十秒，
        而刚体一建好就在那儿了。这段时间里如果它是 dynamic 又没有碰撞体（碰撞体要等
        包围盒），一进第一人称它就会往下掉——"还没加载完的家具先掉出场景"。
        `type` 是 @react-three/rapier 的可变选项（内部走 `setBodyType`），
        包围盒一到就换成 dynamic，不需要重建刚体。
      */
      type={box ? "dynamic" : "fixed"}
      // 显式声明碰撞体：绝不让引擎按 mesh 自动生成（那会在百万面的模型上建 trimesh）
      colliders={false}
      position={transform.position}
      rotation={transform.rotation}
      scale={transform.scale}
      linearDamping={OBJECT_LINEAR_DAMPING}
      angularDamping={OBJECT_ANGULAR_DAMPING}
      /*
        与 image-blaster 的 `SceneObject` **逐项对齐**（抓取手感照抄它的，见 `useObjectGrab`）。
        `additionalSolverIterations` 不是可有可无：抓取用的球形关节是**位置级硬约束**，
        默认迭代下它和地面接触会解不干净、形成极限环。同一场景台架
        （`.tmp/grab-bench/iterations.mjs`，手压进地面 50 mm）读数：
        0 次额外迭代 ⇒ y 峰峰 **6.07 mm**（肉眼可见的抖）；4 次 ⇒ **0.97 mm**（0.6 px，看不见）。
        8 次是 0.76 mm，收益已经不大了，所以照抄它的 4。
      */
      additionalSolverIterations={4}
      // 甩出去的物体会很快（抓取限速 5 m/s），开 CCD 免得穿墙
      ccd
      canSleep
      // 准星抓取靠它反查资产（见 assetId 的说明）；角色刚体是 `{ character: true }`，两者互不干扰
      userData={{ assetId }}
      transformState={(state) => {
        // 建好就睡：物理没在跑时保持"编辑器里摆在哪就是哪"，
        // 进了第一人称也只在你碰到它时才醒来。
        state.rigidBody.sleep();
        reportObject.current?.(state.object);
        return state;
      }}
    >
      {box && <CuboidCollider args={box.halfExtents} />}
      {children}
    </RigidBody>
  );
}
