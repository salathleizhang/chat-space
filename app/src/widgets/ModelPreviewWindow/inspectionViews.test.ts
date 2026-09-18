import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createInspectionCamera, INSPECTION_VIEWS } from "./inspectionViews";

describe("inspection camera projections", () => {
  const center = new THREE.Vector3(3, 2, -4);

  test.each([
    { label: "TOP", right: [1, 0, 0], up: [0, 0, -1], toward: [0, 1, 0] },
    { label: "FRONT", right: [1, 0, 0], up: [0, 1, 0], toward: [0, 0, 1] },
    { label: "RIGHT", right: [0, 0, -1], up: [0, 1, 0], toward: [1, 0, 0] },
  ])("$label projects world axes without roll or tilt", ({ label, right, up, toward }) => {
    const source = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    // 用户之前转动过视角球也不应改变检查图的朝向。
    source.up.set(1, 1, 1).normalize();
    const view = INSPECTION_VIEWS.find((v) => v.label === label)!;
    const camera = createInspectionCamera(source, view, center, 2);
    expect(camera).toBeInstanceOf(THREE.OrthographicCamera);

    const projectOffset = (offset: readonly number[]) =>
      center.clone().add(new THREE.Vector3(...offset)).project(camera);
    const origin = center.clone().project(camera);
    const screenRight = projectOffset(right);
    const screenUp = projectOffset(up);
    const screenDepth = projectOffset(toward);

    expect(origin.x).toBeCloseTo(0, 10);
    expect(origin.y).toBeCloseTo(0, 10);
    expect(screenRight.x).toBeGreaterThan(0);
    expect(screenRight.y).toBeCloseTo(0, 10);
    expect(screenUp.x).toBeCloseTo(0, 10);
    expect(screenUp.y).toBeGreaterThan(0);
    expect(screenDepth.x).toBeCloseTo(0, 10);
    expect(screenDepth.y).toBeCloseTo(0, 10);
    expect(source.up.x).toBeCloseTo(1 / Math.sqrt(3), 10);
  });

  test("ISO keeps perspective projection", () => {
    const source = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    const camera = createInspectionCamera(source, INSPECTION_VIEWS[0]!, center, 2);
    expect(camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(camera).not.toBe(source);
  });
});
