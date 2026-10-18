import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { allowedProviderUrl, proxyFetch, verifiedDownload } from "./proxy";
test("credential proxy rejects destination and URL credential tricks", () => {
  for (const url of ["http://ark.cn-beijing.volces.com/api/v3/chat/completions", "https://ark.cn-beijing.volces.com.evil.test/api/v3/chat/completions", "https://user@openapi.tripo3d.ai/v3/tasks/fixture", "https://openapi.tripo3d.ai:444/v3/files", "https://openapi.tripo3d.ai/v3/account", "https://127.0.0.1/v3/files"]) expect(allowedProviderUrl(url)).toBeUndefined();
  expect(allowedProviderUrl("https://ark.cn-beijing.volces.com/api/v3/chat/completions")?.hostname).toBe("ark.cn-beijing.volces.com");
  expect(allowedProviderUrl("https://openapi.tripo3d.ai/v3/tasks/list")?.hostname).toBe("openapi.tripo3d.ai");
});
test("cross-origin proxy requests are rejected before credentials or fetch", async () => {
  const response = await proxyFetch(new Request("https://chatspace.test/api/provider?url=https://openapi.tripo3d.ai/v3/files", { method: "POST", headers: { Origin: "https://untrusted.test" } }));
  expect(response.status).toBe(403);
});
test("health does not require any database, Blob or session credential", async () => {
  const response = await proxyFetch(new Request("https://chatspace.test/api/health"));
  expect(await response.json()).toMatchObject({ ok: true, storage: "browser-local" });
});
test("signed download tickets cannot be altered or point to private hosts", () => {
  const secret = "fixture-only-session-secret";
  const ticket = (url: string) => {
    const value = Buffer.from(JSON.stringify({ url })).toString("base64url");
    return `${value}.${createHmac("sha256", secret).update(`download:${value}`).digest("base64url")}`;
  };
  expect(verifiedDownload(ticket("https://cdn.tripo3d.ai/model.glb"), secret)?.pathname).toBe("/model.glb");
  expect(verifiedDownload(ticket("https://127.0.0.1/model.glb"), secret)).toBeUndefined();
  expect(verifiedDownload(ticket("https://cdn.tripo3d.ai/model.glb") + "tampered", secret)).toBeUndefined();
  expect(verifiedDownload(ticket("https://cdn.tripo3d.ai/model.glb"), "other-secret")).toBeUndefined();
});
