import type { Material, Object3D } from "three";

/** 材质是否可能产生绘制：`visible === false` 的材质（含数组里全部不可见）不算。 */
function hasVisibleMaterial(material: Material | Material[] | null | undefined): boolean {
  if (material === undefined || material === null) return true;
  if (Array.isArray(material)) return material.some((entry) => entry?.visible !== false);
  return material.visible !== false;
}

/**
 * `root` 被渲染时会不会产生至少一次 draw call。
 *
 * 为什么需要它：叠加层场景里绝大多数对象**不可绘制**——拾取代理是裸 `Object3D`
 * （只有 `raycast`，没有几何体，见 `sharedPicking.ts`），`DrawView` 还固定挂了一个空的
 * `<group onPointerOver>`。可空场景照样要走完一整趟 `gl.render()`：在 WebGPU 后端上那是
 * `beginRender` + `finishRender`（一次 `queue.submit`、一次 swapchain 取纹理），而且因为
 * `outputColorSpace ≠ workingColorSpace`，中间 framebuffer 还会被全屏 blit 回画布一次——
 * 复制的是上一趟刚刚画上去的同一批像素。每个窗格每帧一次，纯浪费。
 *
 * 判据刻意**偏保守**：有一点可能是可绘制的就返回 true（多画一趟只是回到原状，漏画就是
 * 画面缺失）。因此只排除三条确定不产生 draw call 的情况：
 *   ① `visible === false` 的整棵子树；
 *   ② 没有 `geometry` 的节点（组、相机、灯光、裸拾取代理）——`Mesh`/`Line`/`Points`/
 *      `Sprite`/`BatchedMesh` 都有 `geometry`；
 *   ③ 材质显式 `visible === false`。
 * 不做视锥剔除判断：被剔除的对象在 three 里仍然会让那一趟 pass 发生，所以它不属于"可以
 * 跳过整趟"的理由。
 */
export function hasDrawableContent(root: Object3D): boolean {
  let found = false;
  const visit = (object: Object3D) => {
    if (found || object.visible === false) return;
    const candidate = object as Object3D & { geometry?: unknown; material?: Material | Material[] | null };
    if (candidate.geometry !== undefined && hasVisibleMaterial(candidate.material)) {
      found = true;
      return;
    }
    const children = object.children;
    for (let index = 0; index < children.length && !found; index += 1) visit(children[index]!);
  };
  visit(root);
  return found;
}
