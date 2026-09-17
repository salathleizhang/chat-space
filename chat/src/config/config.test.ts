import { describe, expect, test } from "bun:test";
import { createAllowedOriginChecker, createServerCredentialInjector, defaultLibraryRoot } from "./index";

test("已有工程目录优先保留，新安装使用 ChatSpace 目录", () => {
  const home = "/test-home";
  expect(defaultLibraryRoot(home, () => false)).toBe("/test-home/ChatSpace");
  expect(defaultLibraryRoot(home, (path) => String(path).endsWith("/Chatspace"))).toBe("/test-home/Chatspace");
  expect(defaultLibraryRoot(home, (path) => String(path).endsWith("/Gabo"))).toBe("/test-home/Gabo");
  expect(defaultLibraryRoot(home, () => true)).toBe("/test-home/ChatSpace");
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
    },
    {
      baseUrl: "https://ark.example/api/v3",
      model: "glm-5.3",
      deepseekModel: "deepseek-v4-1-flash-260910",
    },
  );

  test("忽略浏览器传来的所有凭证与任意 LLM 端点", () => {
    expect(inject({
      projectSlug: "demo",
      falApiKey: "browser-fal",
      volcengineApiKey: "browser-volc",
      tripo3dApiKey: "browser-tripo",
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
      llm: {
        apiKey: "local-volc",
        provider: "volcengine",
        baseUrl: "https://ark.example/api/v3",
        model: "glm-5.3",
      },
    });
  });

  test("允许选择火山方舟 DeepSeek V4.1 Flash，但实际配置仍由服务端注入", () => {
    expect(inject({ llm: {
      apiKey: "browser-llm",
      baseUrl: "https://evil.example/v1",
      model: "deepseek-v4-1-flash-260910",
    } })).toMatchObject({
      llm: {
        apiKey: "local-volc",
        provider: "volcengine",
        baseUrl: "https://ark.example/api/v3",
        model: "deepseek-v4-1-flash-260910",
      },
    });
  });

  test("缺少本机配置时不接受浏览器补交密钥", () => {
    const empty = createServerCredentialInjector({}, {
      baseUrl: "https://ark.example/api/v3",
      model: "glm-5.3",
      deepseekModel: "deepseek-v4-1-flash-260910",
    });
    expect(empty({ worldLabsApiKey: "browser-world", llm: { apiKey: "browser-llm" } })).toEqual({
      llm: {
        apiKey: "",
        provider: "volcengine",
        baseUrl: "https://ark.example/api/v3",
        model: "glm-5.3",
      },
    });
  });

  test("不改动非对象请求体", () => {
    expect(inject(null)).toBeNull();
    expect(inject([1])).toEqual([1]);
  });
});
