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
test("manual desktop activity is authenticated and fenced; lease refresh never extends idle time or budget", async () => {
  const store = new BlenderStore(":memory:"), vault = new SandboxSecrets(secret);
  const app = createBlenderApi(store, { tick() {} }, { secret, build: "build", desktopOrigin: "https://desktop.example.com", pauseEnabled: true, target: "https://sandbox.example.com/" }, undefined, undefined, vault);
  try {
    const created = store.create("alice", "project", "build", 3_600_000, crypto.randomUUID(), "interactive");
    store.reserveNext(); store.transition(created.id, 1, ["allocating"], "preparing", "sandbox-test");
    store.transition(created.id, 1, ["preparing"], "ready");
    store.saveCredentials(created.id, 1, vault.seal(vault.generate(), created.id, 1));
    store.db.query("UPDATE sessions SET lastActivity=1 WHERE id=?").run(created.id);
    const original = store.session(created.id), input = { owner: "alice", session: created.id, epoch: 1 };
    const headers = { Authorization: "Bearer " + issueIdentity({ owner: "__gateway", scope: "api", expires: Date.now() + 60_000 }, secret), "Content-Type": "application/json" };
    const send = (body: object, h = headers) => app.request("/internal/desktop", { method: "POST", headers: h, body: JSON.stringify(body) });
    expect((await send(input)).status).toBe(200);
    expect(store.session(created.id).lastActivity).toBe(1);
    expect((await send({ ...input, activity: true }, { "Content-Type": "application/json", Authorization: "forged" })).status).toBe(401);
    expect((await send({ ...input, owner: "bob", activity: true })).status).toBe(409);
    expect((await send({ ...input, epoch: 2, activity: true })).status).toBe(409);
    expect(store.session(created.id).lastActivity).toBe(1);
    expect((await send({ ...input, activity: true })).status).toBe(200);
    expect(store.session(created.id).lastActivity).toBeGreaterThan(1);
    expect(store.session(created.id).deadline).toBe(original.deadline);
    expect(store.session(created.id).updatedAt).toBe(original.updatedAt);
    store.transition(created.id, 1, ["ready"], "saving");
    store.setEffect(created.id, 1, "save-mode", "continue");
    expect((await send({ ...input, activity: true })).status).toBe(200);
    store.setEffect(created.id, 1, "save-mode", "end");
    expect((await send({ ...input, activity: true })).status).toBe(409);
    store.transition(created.id, 1, ["saving"], "ready");
    store.db.query("UPDATE sessions SET itemId='batch-item' WHERE id=?").run(created.id);
    expect((await send({ ...input, activity: true })).status).toBe(409);
    store.db.query("UPDATE sessions SET itemId='interactive',deadline=1 WHERE id=?").run(created.id);
    expect((await send({ ...input, activity: true })).status).toBe(409);
  } finally { store.close(); }
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
    store.setEffect(session.id, 0, "provider-error", "ListSandboxes:AccessDenied");
    store.setEffect(session.id, 0, "failures", "6");
    store.setEffect(session.id, 0, "create", "requested");
    const diagnosis = await (await app.request(`/v1/sessions/${session.id}`, { headers: auth("alice") })).json() as { controller: unknown };
    expect(diagnosis.controller).toEqual({ failureCount: 6, lastFailure: "ListSandboxes:AccessDenied", createRequested: true });
    expect((await app.request(`/v1/sessions/${session.id}`, { headers: auth("bob") })).status).toBe(409);
    expect((await (await app.request("/v1/sessions", { headers: auth("bob") })).json() as { sessions: unknown[] }).sessions).toHaveLength(0);
    const disabled = createBlenderApi(store, { tick() {} }, { secret, build: "build", desktopOrigin: "https://blender.example.com", pauseEnabled: false });
    expect((await disabled.request("/v1/sessions", { method: "POST", headers: auth("bob"), body })).status).toBe(503);
    expect(store.list("bob")).toHaveLength(0);
  } finally { store.close(); }
});
