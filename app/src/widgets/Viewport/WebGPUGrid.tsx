import { useEffect, useMemo } from "react";
import { DoubleSide, MeshBasicNodeMaterial } from "three/webgpu";
import { abs, cameraPosition, color, float, fract, fwidth, max, min, mix, positionWorld, vec4 } from "three/tsl";

/** Derivative-antialiased editor grid, expressed in TSL for native WebGPU. */
export function WebGPUGrid() {
  const material = useMemo(() => {
    const line = (size: number, thickness: number) => {
      const p = positionWorld.xz.div(size);
      const grid = abs(fract(p.sub(0.5)).sub(0.5)).div(max(fwidth(p), 0.00001));
      return float(1).sub(min(min(grid.x, grid.y).add(1 - thickness), 1));
    };
    const cells = line(0.5, 0.5);
    const sections = line(5, 1);
    const fade = float(1).sub(positionWorld.xz.distance(cameraPosition.xz).div(40)).clamp().pow(1.5);
    const result = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    result.colorNode = vec4(mix(color("#1a1a1a"), color("#333333"), sections), cells.add(sections).mul(fade).mul(mix(0.75, 1, sections)));
    return result;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  return <mesh rotation-x={-Math.PI / 2} material={material} raycast={() => {}}><planeGeometry args={[400, 400]} /></mesh>;
}
