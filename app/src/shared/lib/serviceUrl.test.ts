import { describe, expect, test } from "bun:test";
import { isLocalChatUrl, resolveChatBaseUrl } from "./serviceUrl";

describe("ChatSpace service address", () => {
  test("public production pages use their deployed origin", () => {
    expect(resolveChatBaseUrl({ production: true, pageOrigin: "https://chatspace.vercel.app" }))
      .toBe("https://chatspace.vercel.app");
  });

  test("local production uses its actual port", () => {
    expect(resolveChatBaseUrl({ production: true, pageOrigin: "http://127.0.0.1:4000" }))
      .toBe("http://127.0.0.1:4000");
  });

  test("development connects to the separate Bun backend", () => {
    expect(resolveChatBaseUrl({ production: false, pageOrigin: "http://localhost:5173" }))
      .toBe("http://127.0.0.1:3901");
  });

  test("an explicit cloud backend overrides the page origin", () => {
    expect(resolveChatBaseUrl({
      configuredUrl: " https://api.example.com/ ", production: true,
      pageOrigin: "https://chatspace.vercel.app",
    })).toBe("https://api.example.com");
  });

  test("an empty explicit URL permits relative same-origin API requests", () => {
    expect(resolveChatBaseUrl({ configuredUrl: "", production: true })).toBe("");
  });

  test("only loopback service addresses receive local startup instructions", () => {
    for (const url of ["http://localhost:3901", "http://127.0.0.1:3901", "http://[::1]:3901"]) {
      expect(isLocalChatUrl(url)).toBe(true);
    }
    for (const url of ["https://api.example.com", "https://localhost.example.com", ""]) {
      expect(isLocalChatUrl(url)).toBe(false);
    }
  });
});
