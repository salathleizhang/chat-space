import { expect, test } from "bun:test";
import { forwardBlender } from "./blenderProxy";
import { verifyIdentity } from "../blenderService/auth";
const settings = { BLENDER_SERVICE_URL: "https://blender-service.example/", BLENDER_SERVICE_SECRET: "fixture-only-secret-".repeat(3) };
test("Blender forwarding signs the workspace owner, ignores supplied auth and strips service cookies", async () => {
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://blender-service.example/v1/sessions");
    const headers = new Headers(init?.headers), identity = verifyIdentity(headers.get("authorization")!.replace("Bearer ", ""), settings.BLENDER_SERVICE_SECRET, "api");
    expect(identity?.owner).toBe("alice"); expect(headers.get("cookie")).toBeNull();
    return Response.json({ sessions: [] }, { headers: { "Set-Cookie": "never-forward=this", "X-Secret": "never" } });
  }) as unknown as typeof fetch;
  const response = await forwardBlender(new Request("https://www.example/api/blender/sessions", { headers: { authorization: "Bearer forged", cookie: "input=private" } }), "alice", settings, fetcher);
  expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toBeNull(); expect(response.headers.get("x-secret")).toBeNull();
});
test("Blender forwarding cannot call internal endpoints, pass query routing, arbitrary hosts or allocate when disabled", async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  for (const path of ["internal/tick", "sessions?faasInstanceName=other", "sessions/anything", "batches/not-uuid/cancel"])
    expect((await forwardBlender(new Request("https://www.example/api/blender/" + path), "alice", settings, fetcher)).status).toBe(403);
  expect((await forwardBlender(new Request("https://www.example/api/blender/sessions"), "alice", {}, fetcher)).status).toBe(503);
  await expect(forwardBlender(new Request("https://www.example/api/blender/sessions"), "alice", { ...settings, BLENDER_SERVICE_URL: "http://attacker/" }, fetcher)).rejects.toThrow("Invalid Blender service URL");
  expect(calls).toBe(0);
});
