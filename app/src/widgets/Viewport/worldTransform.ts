import type { WorldSemantics } from "../../shared/lib/libraryApi";

/**
 * 把 World Labs 的语义元数据翻译成 three.js 的 group 变换。
 *
 * **World Labs 的坐标系是 +Y 朝下**（实测其 collider 网格 94.7% 的顶点法线指向 −Y），
 * 照原样渲染整个世界是倒过来的。三个值各司其职：
 *   - `flipY`：绕 X 轴转 π，把 −Y 变成"上"
 *   - `metricScaleFactor`：统一缩放，让场景是真实米制
 *   - `groundPlaneOffset`：Y 平移，把地面抬到 y=0
 *
 * 泼溅（画面）与 collider（物理/地形参照）必须用**同一份**变换，所以只此一处；
 * 对齐 image-blaster 的做法（它把同一组参数同时套在 SplatMesh 与 RigidBody 上）。
 * three.js 的 group 按 T·R·S 组合，这里 uniform scale 与绕 X 的 π 旋转可交换，顺序无影响。
 */
export interface WorldTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}

export function worldTransform(semantics: WorldSemantics): WorldTransform {
  return {
    position: [0, semantics.groundPlaneOffset, 0],
    rotation: [semantics.flipY ? Math.PI : 0, 0, 0],
    scale: semantics.metricScaleFactor,
  };
}
