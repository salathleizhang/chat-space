import { Vec3 } from "playcanvas";
import {
  eulerXyzFromQuat,
  IDENTITY_ROTATION,
  quatFromEulerXyz,
  UNIT_SCALE,
  type Placement,
  type Vec3Tuple,
} from "./selectionTransform";

/**
 * 世界的**语义变换**：把 World Labs 的坐标系翻成应用的世界坐标。
 *
 * ### 为什么必须有
 * World Labs 的坐标系是 **+Y 朝下**（three 侧实测：它的 collider 网格 94.7% 的顶点法线指向 −Y），
 * 照原样渲染整个房间是**倒过来的**——真机症状是"家具被一片巨大的地面/天花盖住、整屏都是室内面"。
 * three 侧一直把 `worldSemantics` 翻成 group 变换（`widgets/Viewport/worldTransform.ts`），
 * **PC 分支此前完全没读这个字段**：世界资产刚能加载时就是倒的。
 *
 * 三个值各司其职（与 three 侧逐项一致）：
 *  - `flipY`：绕 **X** 轴转 π，把 −Y 变成"上"；
 *  - `metricScaleFactor`：统一缩放，让场景是真实米制；
 *  - `groundPlaneOffset`：Y 平移，把地面抬到 y=0。
 *
 * ### 为什么写成 placement 而不是直接设实体
 * `Placement` 是 three 约定（位置 / **弧度 XYZ** / 缩放），`panePlacement` 已经负责把它写进引擎实体
 * （欧拉↔四元数自己写、不喂引擎的欧拉 API——引擎是**角度 + ZYX**，见 `selectionTransform.ts` 文件头）。
 * 这里只做"语义 ∘ 用户摆放"的合成，产出同一套约定，其余交给既有那条路。
 */
export interface WorldSemanticsLike {
  flipY: boolean;
  metricScaleFactor: number;
  groundPlaneOffset: number;
}

const IDENTITY: Placement = { position: [0, 0, 0], rotation: [...IDENTITY_ROTATION], scale: [...UNIT_SCALE] };

/** 语义元数据本身对应的变换（three 侧 `worldTransform()` 的同一份规则）。 */
export function semanticPlacement(semantics: WorldSemanticsLike): Placement {
  const scale = semantics.metricScaleFactor;
  return {
    position: [0, semantics.groundPlaneOffset, 0],
    rotation: [semantics.flipY ? Math.PI : 0, 0, 0],
    scale: [scale, scale, scale],
  };
}

/**
 * 世界实体的最终摆放 = **语义变换 ∘ 用户摆放**（世界被 gizmo 调过时也要跟着走）。
 *
 * 合成按 three 的 `M = T_sem·R_sem·S_sem · T_user·R_user·S_user`：
 *  - 旋转 = `q_sem ⊗ q_user`；
 *  - 缩放 = 逐分量相乘（两者都是对角缩放）；
 *  - 位置 = `T_sem + R_sem·(S_sem·T_user)` —— 里层的位置要先被外层缩放、再被外层旋转。
 *
 * ⚠️ **一个已知的表达力边界**：three 侧是**两级 group**（外层语义、里层 SplatModel），
 * 所以"非等比缩放 × 带朝向"这种组合下它是一串矩阵相乘；而这里必须压成**一个** TRS，
 * 那种组合会退化成剪切、表示不出来（three 的 `decompose` 同样会给出近似值）。
 * 现实里世界是背景、不会有人非等比缩放它，所以按单一 TRS 处理；真要支持的话，
 * 得像 three 那样给世界加一层不渲染的父实体。
 *
 * `semantics` 为空（老数据没写这个字段）时**不猜**：原样返回用户摆放。
 */
export function worldPlacement(
  semantics: WorldSemanticsLike | null | undefined,
  user?: Placement | null,
): Placement {
  const base = user ?? IDENTITY;
  if (!semantics) return base;
  const outer = semanticPlacement(semantics);

  const outerRotation = quatFromEulerXyz(outer.rotation);
  // 里层位置 → 外层缩放 → 外层旋转 → 加上外层平移
  const offset = new Vec3(
    base.position[0] * outer.scale[0],
    base.position[1] * outer.scale[1],
    base.position[2] * outer.scale[2],
  );
  outerRotation.transformVector(offset, offset);

  // 注意 `Quat.mul` 是**就地**修改：合成后的旋转不能覆写上面那个"纯外层旋转"，
  // 否则位置的换算会拿到已经乘过里层的四元数（本机踩过：位置被多转了一次）。
  const rotation = eulerXyzFromQuat(outerRotation.clone().mul(quatFromEulerXyz(base.rotation)));

  const scale: Vec3Tuple = [
    outer.scale[0] * base.scale[0],
    outer.scale[1] * base.scale[1],
    outer.scale[2] * base.scale[2],
  ];
  const position: Vec3Tuple = [
    outer.position[0] + offset.x,
    outer.position[1] + offset.y,
    outer.position[2] + offset.z,
  ];
  return { position, rotation, scale };
}
