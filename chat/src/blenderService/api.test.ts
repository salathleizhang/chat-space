import { expect, test } from "bun:test";
import { createBlenderApi } from "./api";
import { issueIdentity, verifyIdentity } from "./auth";
import { SandboxSecrets } from "./secrets";
import { BlenderStore } from "./store";
const secret = "service-secret-".repeat(4);
test("service rejects forged/expired identities and desktop tokens used as API tokens", () => {
  const token = issueIdentity({ owner: "alice", scope: "api", expires: Date.now() + 60_000 }, secret);
  expect(verifyIdentity(token, secret, "api")?.owner).toBe("alice");
  expect(verifyIdentity(token + "x", secret, "api")).toBeNull();
  expect(verifyIdentity(token, secret, "desktop")).toBeNull();
  expect(verifyIdentity(token, secret, "api", Date.now() + 70_000)).toBeNull();
});
test("encrypted credentials are bound to their session and epoch", () => {
  const vault = new SandboxSecrets(secret), values = vault.generate(), sealed = vault.seal(values, "session", 1);
  expect(sealed).not.toContain(values.control);
  expect(vault.open(sealed, "session", 1)).toEqual(values);
  expect(() => vault.open(sealed, "other-session", 1)).toThrow();
  expect(() => vault.open(sealed, "session", 2)).toThrow();
});
test("API preserves ownership, idempotency and disables allocation before pause acceptance", async () => {
  const store = new BlenderStore(":memory:"), app = createBlenderApi(store, { tick() {} }, { secret, build: "custom-build", desktopOrigin: "https://blender.example.com", pauseEnabled: true });
  const auth = (owner: string) => ({ Authorization: "Bearer " + issueIdentity({ owner, scope: "api", expires: Date.now() + 60_000 }, secret), "Content-Type": "application/json" });
  try {
    expect((await app.request("/v1/sessions")).status).toBe(401);
    const body = JSON.stringify({ project: "project", requestId: crypto.randomUUID() });
    const response = await app.request("/v1/sessions", { method: "POST", headers: auth("alice"), body });
    const { session } = await response.json() as { session: { id: string } }; expect(response.status).toBe(202);
    const duplicate = await (await app.request("/v1/sessions", { method: "POST", headers: auth("alice"), body })).json() as { session: { id: string } };
    expect(duplicate.session.id).toBe(session.id);
    expect((await app.request(`/v1/sessions/${session.id}`, { headers: auth("bob") })).status).toBe(409);
    expect((await (await app.request("/v1/sessions", { headers: auth("bob") })).json() as { sessions: unknown[] }).sessions).toHaveLength(0);
    const disabled = createBlenderApi(store, { tick() {} }, { secret, build: "build", desktopOrigin: "https://blender.example.com", pauseEnabled: false });
    expect((await disabled.request("/v1/sessions", { method: "POST", headers: auth("bob"), body })).status).toBe(503);
    expect(store.list("bob")).toHaveLength(0);
  } finally { store.close(); }
});
