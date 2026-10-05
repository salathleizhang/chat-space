import { describe, expect, test } from "bun:test";
import {
  HAND_MODEL_URL,
  HAND_WASM_CDN,
  describeCameraError,
  describeModelError,
  resolveHandTrackingSource,
} from "./useHandTracking";

/**
 * 来源解析与错误文案：这两件事都发生在"用户看不到任何东西"的时刻，
 * 所以文案必须具体（"相机被拒"与"模型下载失败"要能分辨），来源必须可覆盖（离线部署）。
 */

describe("wasm / 模型的来源", () => {
  test("默认走 jsDelivr 的 wasm 与 Google 的模型", () => {
    const source = resolveHandTrackingSource("");
    expect(source.wasmBase).toBe(HAND_WASM_CDN);
    expect(source.modelUrl).toBe(HAND_MODEL_URL);
  });

  test("CDN 路径里的版本号必须与 npm 包锁定的版本一致（错配是静默的运行时错误）", () => {
    // 与 app/package.json 的 "@mediapipe/tasks-vision": "0.10.17" 同版本；
    // 升级依赖时这一条会失败，提醒一起改（wasm 与 js 的接口在 0.10.x 里动过）
    expect(HAND_WASM_CDN).toContain("@mediapipe/tasks-vision@0.10.17");
  });

  test("?handWasm= / ?handModel= 可以覆盖成本地副本，末尾斜杠会被抹掉", () => {
    const source = resolveHandTrackingSource("?handDebug=1&handWasm=/mediapipe/wasm/&handModel=/mediapipe/hand.task");
    expect(source.wasmBase).toBe("/mediapipe/wasm");
    expect(source.modelUrl).toBe("/mediapipe/hand.task");
  });

  test("query 里没有覆盖项时保持默认（别把空串当覆盖）", () => {
    const source = resolveHandTrackingSource("?handWasm=&handModel=");
    expect(source.wasmBase).toBe(HAND_WASM_CDN);
    expect(source.modelUrl).toBe(HAND_MODEL_URL);
  });
});

describe("错误文案", () => {
  test("相机错误按名字分类（权限 / 没有设备 / 被占用）", () => {
    expect(describeCameraError({ name: "NotAllowedError" })).toBe("Camera permission denied");
    expect(describeCameraError({ name: "SecurityError" })).toBe("Camera permission denied");
    expect(describeCameraError({ name: "NotFoundError" })).toBe("No camera found");
    expect(describeCameraError({ name: "OverconstrainedError" })).toBe("No camera found");
    expect(describeCameraError({ name: "NotReadableError" })).toBe("Camera is in use by another app");
    expect(describeCameraError(new Error("boom"))).toBe("Could not start the camera");
    expect(describeCameraError(null)).toBe("Could not start the camera");
  });

  test("模型错误带上原因，并且截断（wasm 的报错可能是一大段）", () => {
    expect(describeModelError(new Error("network"))).toBe("Hand model failed: network");
    expect(describeModelError(new Error("x".repeat(500))).length).toBeLessThan(160);
    expect(describeModelError(undefined)).toBe("Hand model failed to load");
  });
});
