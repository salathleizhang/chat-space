import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearLegacyApiKeys,
  loadImageGenerateModelSettings,
  loadLlmSettings,
  loadThreeDModelSettings,
  saveLlmSettings,
  saveThreeDModelSettings,
} from "./apiKeys";

beforeEach(() => localStorage.clear());

describe("server-only provider migration", () => {
  test("清除旧版浏览器密钥，不碰模型偏好", () => {
    localStorage.setItem("gabo.apiKeys", JSON.stringify({ obsolete: "secret" }));
    localStorage.setItem("gabo.apiKeys:v1", JSON.stringify({ volcengine: "secret" }));
    localStorage.setItem("gabo.llmSettings:v1", JSON.stringify({ model: "glm-5-3-flash-260828" }));
    clearLegacyApiKeys();
    expect(localStorage.getItem("gabo.apiKeys")).toBeNull();
    expect(localStorage.getItem("gabo.apiKeys:v1")).toBeNull();
    expect(loadLlmSettings().model).toBe("glm-5-3-flash-260828");
    expect(localStorage.getItem("gabo.llmSettings:v1")).toBeNull();
    expect(JSON.parse(localStorage.getItem("chatspace.llmSettings:v1")!)).toEqual({ model: "glm-5-3-flash-260828" });
  });

  test("旧版不支持的模型与供应商偏好不会继续选中", () => {
    localStorage.setItem("gabo.llmSettings:v1", JSON.stringify({ model: "gpt-4o" }));
    localStorage.setItem("gabo.threeDProviderSettings:v1", JSON.stringify({ provider: "removed-provider" }));
    localStorage.setItem("gabo.imageGenerateModelSettings:v1", JSON.stringify({ model: "nano-banana" }));
    expect(loadLlmSettings().model).toBe("");
    expect(loadThreeDModelSettings().model).toBe("");
    expect(loadImageGenerateModelSettings().model).toBe("");
  });

  test("旧 GLM-5.3 选择迁移到 GLM 5.3 Flash", () => {
    localStorage.setItem("chatspace.llmSettings:v1", JSON.stringify({ model: "glm-5.3" }));
    expect(loadLlmSettings()).toEqual({ provider: "volcengine", baseUrl: "", model: "glm-5-3-flash-260828" });
  });

  test("已移除的 Seed 2.0 Lite 回退到默认模型", () => {
    localStorage.setItem("chatspace.llmSettings:v1", JSON.stringify({ model: "doubao-seed-2-0-lite-260215" }));
    expect(loadLlmSettings()).toEqual({ provider: "", baseUrl: "", model: "" });
  });

  test.each([
    "glm-5-3-flash-260828",
    "deepseek-v4-1-flash-260910",
    "doubao-seed-evolving",
    "doubao-seed-2-1-pro-260915",
  ])("保存并恢复模型选择：%s", (model) => {
    expect(saveLlmSettings({
      provider: "volcengine",
      baseUrl: "https://untrusted.example/v1",
      model,
    })).toBe(true);
    expect(loadLlmSettings()).toEqual({
      provider: "volcengine",
      baseUrl: "",
      model,
    });
    expect(JSON.parse(localStorage.getItem("chatspace.llmSettings:v1")!)).toEqual({
      provider: "volcengine",
      baseUrl: "",
      model,
    });
  });

  test.each([
    ["seed3d-direct", ""],
    ["hyper3d-volc", ""],
    ["hi3d-volc", ""],
    ["tripo-direct", "tripo-3-1"],
  ])("旧版渠道偏好迁移，隐藏模型回退到 Auto：%s → %s", (provider, model) => {
    localStorage.setItem("chatspace.threeDProviderSettings:v1", JSON.stringify({ provider }));
    expect(loadThreeDModelSettings().model).toBe(model);
  });

  test("旧键（gabo 前缀）里的 3D 渠道偏好同样迁移", () => {
    localStorage.setItem("gabo.threeDProviderSettings:v1", JSON.stringify({ provider: "hi3d-volc" }));
    expect(loadThreeDModelSettings().model).toBe("");
  });

  test.each(["seed3d-2", "hyper3d-gen2", "hi3d-2", "tripo-3-1", "tripo-p1", "tripo-p2"])(
    "保存并恢复 3D 模型选择，隐藏模型回退到 Auto：%s",
    (model) => {
      const expected = ["seed3d-2", "hyper3d-gen2", "hi3d-2"].includes(model) ? "" : model;
      localStorage.setItem("chatspace.threeDModelSettings:v1", JSON.stringify({ model }));
      expect(loadThreeDModelSettings().model).toBe(expected);
      expect(saveThreeDModelSettings({ model })).toBe(true);
      expect(loadThreeDModelSettings().model).toBe(expected);
      expect(JSON.parse(localStorage.getItem("chatspace.threeDModelSettings:v1")!)).toEqual({ model: expected });
    },
  );

  test("保存未注册的 3D 模型回退到 Auto", () => {
    expect(saveThreeDModelSettings({ model: "hyper3d-direct" })).toBe(true);
    expect(loadThreeDModelSettings().model).toBe("");
  });

  test("新键存在时不再读旧渠道偏好", () => {
    localStorage.setItem("chatspace.threeDProviderSettings:v1", JSON.stringify({ provider: "tripo-direct" }));
    saveThreeDModelSettings({ model: "" });
    expect(loadThreeDModelSettings().model).toBe("");
  });

  test("图片模型偏好从旧键迁移到 ChatSpace", () => {
    localStorage.setItem("gabo.imageGenerateModelSettings:v1", JSON.stringify({ model: "seedream" }));
    expect(loadImageGenerateModelSettings().model).toBe("seedream");
    expect(localStorage.getItem("gabo.imageGenerateModelSettings:v1")).toBeNull();
    expect(JSON.parse(localStorage.getItem("chatspace.imageGenerateModelSettings:v1")!)).toEqual({ model: "seedream" });
  });

  test.each(["seedream-5", "seedream-5-pro"])("保存并恢复图片模型：%s", (model) => {
    localStorage.setItem("chatspace.imageGenerateModelSettings:v1", JSON.stringify({ model }));
    expect(loadImageGenerateModelSettings().model).toBe(model);
  });
});
