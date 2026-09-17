import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearLegacyApiKeys,
  loadImageGenerateModelSettings,
  loadLlmSettings,
  loadThreeDProviderSettings,
  saveLlmSettings,
} from "./apiKeys";

beforeEach(() => localStorage.clear());

describe("server-only provider migration", () => {
  test("清除旧版浏览器密钥，不碰模型偏好", () => {
    localStorage.setItem("gabo.apiKeys", JSON.stringify({ fal: "secret" }));
    localStorage.setItem("gabo.apiKeys:v1", JSON.stringify({ volcengine: "secret" }));
    localStorage.setItem("gabo.llmSettings:v1", JSON.stringify({ model: "glm-5.3" }));
    clearLegacyApiKeys();
    expect(localStorage.getItem("gabo.apiKeys")).toBeNull();
    expect(localStorage.getItem("gabo.apiKeys:v1")).toBeNull();
    expect(loadLlmSettings().model).toBe("glm-5.3");
  });

  test("旧版不支持的模型与供应商偏好不会继续选中", () => {
    localStorage.setItem("gabo.llmSettings:v1", JSON.stringify({ model: "gpt-4o" }));
    localStorage.setItem("gabo.threeDProviderSettings:v1", JSON.stringify({ provider: "meshy" }));
    localStorage.setItem("gabo.imageGenerateModelSettings:v1", JSON.stringify({ model: "nano-banana" }));
    expect(loadLlmSettings().model).toBe("");
    expect(loadThreeDProviderSettings().provider).toBe("");
    expect(loadImageGenerateModelSettings().model).toBe("");
  });

  test("保存并恢复 DeepSeek V4.1 Flash 选择", () => {
    expect(saveLlmSettings({
      provider: "volcengine",
      baseUrl: "https://untrusted.example/v1",
      model: "deepseek-v4-1-flash-260910",
    })).toBe(true);
    expect(loadLlmSettings()).toEqual({
      provider: "volcengine",
      baseUrl: "",
      model: "deepseek-v4-1-flash-260910",
    });
    expect(JSON.parse(localStorage.getItem("gabo.llmSettings:v1")!)).toEqual({
      provider: "volcengine",
      baseUrl: "",
      model: "deepseek-v4-1-flash-260910",
    });
  });

  test.each(["hyper3d-volc", "hi3d-volc"])("保留火山方舟 3D 模型偏好：%s", (provider) => {
    localStorage.setItem("gabo.threeDProviderSettings:v1", JSON.stringify({ provider }));
    expect(loadThreeDProviderSettings().provider).toBe(provider);
  });
});
