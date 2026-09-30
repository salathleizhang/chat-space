import { DoubleSide, MeshBasicNodeMaterial } from "three/webgpu";
import { abs, cameraPosition, color, float, fract, fwidth, max, min, mix, positionWorld, vec4 } from "three/tsl";

/**
 * 编辑器网格只有这一份材质，做成模块级单例。
 *
 * 它没有任何参数，所以"每次挂载重建"本来就没有好处；而原来的写法（`useMemo` 建 +
 * `useEffect(() => () => material.dispose(), [material])`）是 StrictMode 的经典陷阱：
 * 回放时 cleanup 会把**已经提交、正在用**的那一份 dispose 掉（见 `DeferredResource` 的注释
 * 与 `envTexture.ts`）。单例把这个类别整个消掉。
 */
const gridMaterial = (() => {
  const line = (size: number, thickness: number) => {
    const p = positionWorld.xz.div(size);
    const grid = abs(fract(p.sub(0.5)).sub(0.5)).div(max(fwidth(p), 0.00001));
    return float(1).sub(min(min(grid.x, grid.y).add(1 - thickness), 1));
  };
  const cells = line(0.5, 0.5);
  const sections = line(5, 1);
  const fade = float(1).sub(positionWorld.xz.distance(cameraPosition.xz).div(40)).clamp().pow(1.5);
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  material.colorNode = vec4(mix(color("#1a1a1a"), color("#333333"), sections), cells.add(sections).mul(fade).mul(mix(0.75, 1, sections)));
  material.name = "editor-grid";
  return material;
})();

/** Derivative-antialiased editor grid, expressed in TSL for native WebGPU. */
export function WebGPUGrid() {
  // 名字给整场景检查用：400×400 的平面进包围盒会把场景拍成一个点（见 SceneInspectionCapturer）。
  return <mesh name="editor:grid" rotation-x={-Math.PI / 2} material={gridMaterial} raycast={() => {}}><planeGeometry args={[400, 400]} /></mesh>;
}
