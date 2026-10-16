import { describe, expect, test } from "bun:test";
import {
  HAND_ASSET_VERSION,
  HAND_CDN_SOURCE,
  HAND_MODEL_LOCAL,
  HAND_MODEL_URL,
  HAND_WASM_CDN,
  HAND_WASM_LOCAL,
} from "./handAssets";
import {
  describeCameraError,
  describeModelError,
  handTrackingFallbacks,
  resolveHandTrackingSource,
} from "./useHandTracking";

/**
 * 来源解析与错误文案：这两件事都发生在"用户看不到任何东西"的时刻，
 * 所以文案必须具体（"相机被拒"与"模型下载失败"要能分辨），来源必须可覆盖（离线部署）。
 */

describe("wasm / 模型的来源", () => {
  test("默认走**同源**资产（不再默认从第三方下载）", () => {
    const source = resolveHandTrackingSource("");
    expect(source.wasmBase).toBe(HAND_WASM_LOCAL);
    expect(source.modelUrl).toBe(HAND_MODEL_LOCAL);
  });

  test("同源与其他路径里的版本号必须一致，且与 npm 包里装的版本一致", async () => {
    // wasm 与 js 错配是**静默的运行时错误**（加载到一半报无意义的 RuntimeError），
    // 所以版本号在这里与 `app/package.json` 对一次；
    // `app/scripts/sync-hand-assets.ts` 在 dev / build 之前还会再对一次。
    expect(HAND_WASM_LOCAL).toContain(HAND_ASSET_VERSION);
    expect(HAND_WASM_CDN).toContain(`@mediapipe/tasks-vision@${HAND_ASSET_VERSION}`);
    const manifest = JSON.parse(
      await Bun.file(new URL("../../../package.json", import.meta.url)).text(),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@mediapipe/tasks-vision"]).toBe(HAND_ASSET_VERSION);
  });

  test("?handWasm= / ?handModel= 可以覆盖来源，末尾斜杠会被抹掉", () => {
    const source = resolveHandTrackingSource("?handDebug=1&handWasm=/mediapipe/wasm/&handModel=/mediapipe/hand.task");
    expect(source.wasmBase).toBe("/mediapipe/wasm");
    expect(source.modelUrl).toBe("/mediapipe/hand.task");
  });

  test("query 里没有覆盖项时保持默认（别把空串当覆盖）", () => {
    const source = resolveHandTrackingSource("?handWasm=&handModel=");
    expect(source.wasmBase).toBe(HAND_WASM_LOCAL);
    expect(source.modelUrl).toBe(HAND_MODEL_LOCAL);
  });
});

describe("兜底来源", () => {
  test("默认来源挂了才接 CDN（同源资产漏部署、只发 SIMD 那一套时的 404 都靠它）", () => {
    // 整对象比：只比长度的话，"兜底指到了别的 wasm 目录"这种错法照样能过
    expect(handTrackingFallbacks("")).toEqual([HAND_CDN_SOURCE]);
    expect(HAND_CDN_SOURCE.wasmBase).toBe(HAND_WASM_CDN);
    expect(HAND_CDN_SOURCE.modelUrl).toBe(HAND_MODEL_URL);
  });

  test("用户显式指定来源时**不**兜底（静默换源比加载失败更难查）", () => {
    expect(handTrackingFallbacks("?handWasm=/w&handModel=/m.task")).toEqual([]);
    // 只覆盖一项也算显式指定：否则"改 wasm 目录、模型仍走同源"会被换到 CDN 的模型
    expect(handTrackingFallbacks("?handModel=/m.task")).toEqual([]);
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
