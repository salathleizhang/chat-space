import { describe, expect, test } from "bun:test";
import { createAllowedOriginChecker, createServerCredentialInjector, defaultLibraryRoot } from "./index";

test("默认工程目录为 ChatSpace", () => {
  expect(defaultLibraryRoot("/test-home")).toBe("/test-home/ChatSpace");
});

test("线上来源仅按完整 origin 放行", () => {
  const allowed = createAllowedOriginChecker("https://chatspace.example.com, https://preview.chatspace.pages.dev");
  expect(allowed("http://localhost:5173")).toBe(true);
  expect(allowed("https://chatspace.example.com")).toBe(true);
  expect(allowed("https://preview.chatspace.pages.dev")).toBe(true);
  expect(allowed("https://chatspace.example.com.evil.test")).toBe(false);
  expect(allowed("https://other.chatspace.pages.dev")).toBe(false);
});

describe("server credentials", () => {
  const inject = createServerCredentialInjector(
    {
      volcengineApiKey: "local-volc",
      seed3dApiKey: "local-volc",
      tripo3dApiKey: "local-tripo",
      hunyuanApiKey: "local-secret-id:local-secret-key",
    },
    {
      baseUrl: "https://ark.example/api/v3",
      model: "glm-5-3-flash-260828",
      glmModel: "ep-glm",
      deepseekModel: "ep-deepseek",
      evolvingModel: "ep-evolving",
      proModel: "ep-pro",
    },
  );

  test("忽略浏览器传来的所有凭证与任意 LLM 端点", () => {
    expect(inject({
      projectSlug: "demo",
      volcengineApiKey: "browser-volc",
      tripo3dApiKey: "browser-tripo",
      hunyuanApiKey: "browser-hunyuan",
      llm: {
        apiKey: "browser-llm",
        provider: "openai",
        baseUrl: "https://evil.example/v1",
        model: "different-model",
      },
    })).toEqual({
      projectSlug: "demo",
      volcengineApiKey: "local-volc",
      seed3dApiKey: "local-volc",
      tripo3dApiKey: "local-tripo",
      hunyuanApiKey: "local-secret-id:local-secret-key",
      llm: {
        apiKey: "local-volc",
        provider: "volcengine",
        baseUrl: "https://ark.example/api/v3",
        model: "glm-5-3-flash-260828",
      },
    });
  });

  test.each([
    ["glm-5-3-flash-260828", "ep-glm"],
    ["glm-5.3", "ep-glm"],
    ["deepseek-v4-1-flash-260910", "ep-deepseek"],
    ["doubao-seed-evolving", "ep-evolving"],
    ["doubao-seed-2-1-pro-260915", "ep-pro"],
  ])("模型 %s 使用服务端配置的接入点", (model, endpoint) => {
    expect(inject({ llm: {
      apiKey: "browser-llm",
      baseUrl: "https://evil.example/v1",
      model,
    } })).toMatchObject({
      llm: {
        apiKey: "local-volc",
        provider: "volcengine",
        baseUrl: "https://ark.example/api/v3",
        model: endpoint,
      },
    });
  });

  test.each(["", "doubao-seed-2-0-lite-260215", "__proto__", "ep-untrusted", null])(
    "默认、旧模型和未知模型 %s 使用服务端默认值", (model) => {
      expect(inject({ llm: { model } })).toMatchObject({ llm: { model: "glm-5-3-flash-260828" } });
    },
  );

  test("缺少本机配置时不接受浏览器补交密钥", () => {
    const empty = createServerCredentialInjector({}, {
      baseUrl: "https://ark.example/api/v3",
      model: "glm-5-3-flash-260828",
      glmModel: "ep-glm",
      deepseekModel: "ep-deepseek",
      evolvingModel: "ep-evolving",
      proModel: "ep-pro",
    });
    expect(empty({ worldLabsApiKey: "browser-world", llm: { apiKey: "browser-llm" } })).toEqual({
      llm: {
        apiKey: "",
        provider: "volcengine",
        baseUrl: "https://ark.example/api/v3",
        model: "glm-5-3-flash-260828",
      },
    });
  });

  test("不改动非对象请求体", () => {
    expect(inject(null)).toBeNull();
    expect(inject([1])).toEqual([1]);
  });
});
