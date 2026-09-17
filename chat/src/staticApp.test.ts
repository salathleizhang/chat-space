import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalFetch } from "./staticApp";

describe("local app server", () => {
  let root: string;
  let fetchLocal: ReturnType<typeof createLocalFetch>;
  const apiRequests: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chatspace-static-test-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<html>ChatSpace</html>");
    await writeFile(join(root, "assets", "app.js"), "export const ready = true;");
    fetchLocal = createLocalFetch((request) => {
      apiRequests.push(new URL(request.url).pathname);
      return Response.json({ ok: true });
    }, root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("serves the homepage and direct project routes", async () => {
    for (const path of ["/", "/app", "/app/example-project"]) {
      const response = await fetchLocal(new Request(`http://127.0.0.1:3901${path}`));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<html>ChatSpace</html>");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
    }
  });

  test("serves assets and does not substitute the SPA for missing assets", async () => {
    const asset = await fetchLocal(new Request("http://127.0.0.1:3901/assets/app.js"));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("export const ready = true;");

    const missing = await fetchLocal(new Request("http://127.0.0.1:3901/assets/missing.js"));
    expect(missing.status).toBe(404);
  });

  test("keeps API requests on the existing handler", async () => {
    const response = await fetchLocal(new Request("http://127.0.0.1:3901/api/health"));
    expect(await response.json()).toEqual({ ok: true });
    expect(apiRequests).toContain("/api/health");
  });

  test("handles HEAD and refuses non-GET static requests", async () => {
    const head = await fetchLocal(new Request("http://127.0.0.1:3901/app", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = await fetchLocal(new Request("http://127.0.0.1:3901/app", { method: "POST" }));
    expect(post.status).toBe(405);
  });

  test("rejects paths outside the build directory", async () => {
    const response = await fetchLocal(new Request("http://127.0.0.1:3901/%2e%2e%2fprivate"));
    expect(response.status).toBe(400);
  });

  test("explains when the frontend has not been built", async () => {
    const fetchWithoutBuild = createLocalFetch(() => new Response(), join(root, "missing"));
    const response = await fetchWithoutBuild(new Request("http://127.0.0.1:3901/app"));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("bun run build");
  });
});
