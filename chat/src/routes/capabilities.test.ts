import { describe, expect, test } from "bun:test";
import { createApp } from "../app";

describe("GET /api/capabilities", () => {
  test("只公开已配置 LLM 厂商 id", async () => {
    const response = await createApp().request("/api/capabilities");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { llmProviders: unknown };
    expect(Array.isArray(payload.llmProviders)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("sk-");
    expect(JSON.stringify(payload)).not.toContain("ark-");
  });
});
