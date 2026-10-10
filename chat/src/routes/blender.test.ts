import { expect, test } from "bun:test";
import { createApp } from "../app";

test("Blender connection endpoint describes configuration without exposing credentials", async () => {
  const response = await createApp().request("/api/blender/connection");
  expect(response.status).toBe(200);
  const payload = await response.json() as Record<string, unknown>;
  expect(Object.keys(payload).sort()).toEqual(["enabled", "instanceName", "projectSlug", "transport"]);
  expect(payload.transport).toBe("local");
  expect(payload.instanceName).toBeNull();
  expect(JSON.stringify(payload)).not.toContain("BLENDER_CONTROL_TOKEN");
});
