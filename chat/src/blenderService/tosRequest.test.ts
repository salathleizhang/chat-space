import { expect, test } from "bun:test";
import { TosClient } from "@volcengine/tos-sdk";
import { immutableTosPut } from "./tosRequest";

test("immutable PUT signs required TOS headers without invoking the network adapter or sharing request state", async () => {
  const client = new TosClient({ accessKeyId: "fixture-ak", accessKeySecret: "fixture-sk", region: "cn-beijing", endpoint: "tos-cn-beijing.volces.com" });
  const adapter = client.opts.requestAdapter;
  const [first, second] = await Promise.all([
    immutableTosPut(client, "fixture-bucket", "blender/a/scene.blend", 100, "first-md5", "application/octet-stream"),
    immutableTosPut(client, "fixture-bucket", "blender/b/manifest.json", 200, "second-md5", "application/json"),
  ]);
  expect(client.opts.requestAdapter).toBe(adapter);
  for (const [request, path, bytes, md5] of [[first, "/blender/a/scene.blend", "100", "first-md5"], [second, "/blender/b/manifest.json", "200", "second-md5"]] as const) {
    expect(decodeURIComponent(new URL(request.url).pathname)).toBe(path);
    expect(new URL(request.url).protocol).toBe("https:");
    expect(request.headers["content-length"]).toBe(bytes);
    expect(request.headers["content-md5"]).toBe(md5);
    expect(request.headers["x-tos-forbid-overwrite"]).toBe("true");
    expect(request.headers.authorization).toMatch(/SignedHeaders=[^,]*x-tos-forbid-overwrite/);
    expect(request.headers["x-tos-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  }
  expect(first.headers.authorization).not.toBe(second.headers.authorization);
  await expect(immutableTosPut(client, "fixture-bucket", "outside/path", 100, "md5", "text/plain")).rejects.toThrow("Invalid TOS object");
});
