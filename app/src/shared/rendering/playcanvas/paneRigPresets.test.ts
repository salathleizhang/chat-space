import { describe, expect, test } from "bun:test";
import { rigDirection } from "../../../shared/lib/cameraRig";
import { rigForPaneCamera, TOP_POLAR_EPSILON } from "./paneRigPresets";

describe("窗格机位预设的轴向", () => {
  test("top：相机在正上方（方向 ≈ +Y）", () => {
    const [dx, dy, dz] = rigDirection(rigForPaneCamera("top"));
    expect(dy).toBeGreaterThan(0.999999);
    expect(Math.abs(dx)).toBeLessThan(TOP_POLAR_EPSILON + 1e-9);
    expect(Math.abs(dz)).toBeLessThan(TOP_POLAR_EPSILON + 1e-9);
  });

  test("front：相机在 +Z、朝 −Z 看", () => {
    const [dx, dy, dz] = rigDirection(rigForPaneCamera("front"));
    expect(Math.abs(dx)).toBeLessThan(1e-12);
    expect(Math.abs(dy)).toBeLessThan(1e-12);
    expect(dz).toBeCloseTo(1, 12);
  });

  test("right：相机在 +X、朝 −X 看", () => {
    const [dx, dy, dz] = rigDirection(rigForPaneCamera("right"));
    expect(dx).toBeCloseTo(1, 12);
    expect(Math.abs(dy)).toBeLessThan(1e-12);
    expect(Math.abs(dz)).toBeLessThan(1e-12);
  });

  test("投影：三个轴测格是正交，透视格是透视", () => {
    expect(rigForPaneCamera("top").projection).toBe("orthographic");
    expect(rigForPaneCamera("front").projection).toBe("orthographic");
    expect(rigForPaneCamera("right").projection).toBe("orthographic");
    expect(rigForPaneCamera("perspective").projection).toBe("perspective");
  });

  test("三个轴测格方向两两不同（顶视图不能等于前视图）", () => {
    const key = (kind: "top" | "front" | "right") => rigDirection(rigForPaneCamera(kind)).map((v) => v.toFixed(3)).join(",");
    expect(new Set([key("top"), key("front"), key("right")]).size).toBe(3);
  });
});