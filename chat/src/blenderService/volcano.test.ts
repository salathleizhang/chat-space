import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VolcanoSandboxes, VolcanoError } from "./volcano";
const settings = { accessKeyId: "test-ak", secretKey: "test-secret", region: "cn-beijing", functionId: "201j2k8z", imageInfoId: "verified-image-id" };
test("Wrangler's ESM bundler preserves a constructible SDK signer", async () => {
  const require = createRequire(import.meta.url);
  const esbuild = createRequire(require.resolve("wrangler/package.json"))("esbuild");
  const result = await esbuild.build({ entryPoints: [new URL("./volcano.ts", import.meta.url).pathname], bundle: true,
    format: "esm", platform: "node", write: false,
    banner: { js: `import { createRequire as bundledRequire } from 'node:module'; const require = bundledRequire(${JSON.stringify(import.meta.url)});` } });
  const directory = await mkdtemp(join(tmpdir(), "chatspace-signer-"));
  try {
    const path = join(directory, "volcano.mjs"); await writeFile(path, result.outputFiles[0].text);
    const bundled = await import(path);
    let calls = 0;
    const cloud = new bundled.VolcanoSandboxes(settings, async (_url: string, init: RequestInit) => {
      calls++; expect(new Headers(init.headers).get("authorization")).toContain("Credential=test-ak/");
      return Response.json({ Result: { SandboxId: "bundled-instance" } });
    });
    expect(await cloud.create("bundled", 1, { control: "fixture", desktop: "fixture" }, 3)).toBe("bundled-instance");
    expect(calls).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("sandbox creation pins the preheated image, 8080 entrypoint and independent lease credentials using the documented nested schema", async () => {
  const calls: { action: string; input: any }[] = [];
  const fetcher = (async function (this: unknown, address: string | URL | Request, init?: RequestInit) {
    expect(this).toBe(globalThis);
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers); expect(headers.get("authorization")).toContain("Credential=test-ak");
    const action = new URL(String(address)).searchParams.get("Action")!, input = JSON.parse(String(init?.body)); calls.push({ action, input });
    return Response.json({ Result: { SandboxId: `sandbox-${calls.length}` } });
  }) as unknown as typeof fetch;
  const cloud = new VolcanoSandboxes(settings, fetcher);
  await cloud.create("first", 1, { control: "first-control", desktop: "first-desktop" }, 20);
  await cloud.create("second", 1, { control: "second-control", desktop: "second-desktop" }, 20);
  expect(calls[0]!.input.InstanceImageInfo).toEqual({ Id: "verified-image-id", Port: 8080, Command: "/opt/cloud-gateway/entrypoint.sh" });
  expect(calls[0]!.input.InstanceImageInfoId).toBeUndefined(); expect(calls[0]!.input.Timeout).toBe(20);
  expect(calls[0]!.input.CpuMilli).toBe(8000); expect(calls[0]!.input.MemoryMB).toBe(32768);
  expect(calls[0]!.input.Metadata.chatspace_session).not.toBe(calls[1]!.input.Metadata.chatspace_session);
  expect(calls[0]!.input.Envs).not.toEqual(calls[1]!.input.Envs);
});
test("cloud-compatible manual redirect mode never forwards signed mutations to another host", async () => {
  let calls = 0, cancelled = false;
  const cloud = new VolcanoSandboxes(settings, (async (_url, init) => {
    calls++; expect(init?.redirect).toBe("manual");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 307, headers: { Location: "https://other.example/" } });
  }) as typeof fetch);
  try { await cloud.create("redirect", 1, { control: "fixture", desktop: "fixture" }, 3); throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(VolcanoError); expect((error as VolcanoError).code).toBe("redirect_refused"); expect((error as VolcanoError).unknown).toBe(true); }
  expect(calls).toBe(1); expect(cancelled).toBe(true);
});
test("mutation response loss is explicitly unknown and never automatically retried by the adapter", async () => {
  let calls = 0;
  const cloud = new VolcanoSandboxes(settings, (async () => { calls++; throw new Error("after-provider-accepted"); }) as unknown as typeof fetch);
  try { await cloud.create("session", 1, { control: "fixture", desktop: "fixture" }); throw new Error("Expected unknown"); }
  catch (error) { expect(error).toBeInstanceOf(VolcanoError); expect((error as VolcanoError).unknown).toBe(true); }
  expect(calls).toBe(1);
});
test("resuming uses the remaining runtime allowance instead of granting another hour", async () => {
  let body: any;
  const cloud = new VolcanoSandboxes(settings, (async (_url, init) => {
    body = JSON.parse(String(init?.body)); return Response.json({ Result: { SandboxId: "resumed" } });
  }) as typeof fetch);
  await cloud.resume("sandbox", 7); expect(body.Timeout).toBe(7);
  expect(body.SandboxId).toBe("sandbox");
  await expect(cloud.resume("sandbox", 61)).rejects.toThrow();
});
test("default active list cannot make an actual paused snapshot disappear; empty provider types are normalized", async () => {
  const bodies: any[] = [];
  const cloud = new VolcanoSandboxes(settings, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    const rows = body.Paused ? [{ Id: "paused", Status: "Paused", InstanceType: "", Metadata: { chatspace_session: "session" } }] : [{ Id: "running", Status: "Ready", InstanceType: "" }];
    return Response.json({ Result: { Sandboxes: body.SandboxId ? rows.filter(r => r.Id === body.SandboxId) : rows, Total: rows.length } });
  }) as typeof fetch);
  expect(await cloud.list()).toMatchObject([{ id: "running", type: "activated" }, { id: "paused", status: "Paused", type: "frozen" }]);
  expect(await cloud.list({ instance: "paused" })).toMatchObject([{ id: "paused", type: "frozen" }]);
  expect(bodies.at(-1).Paused).toBe(true);
  const before = bodies.length;
  expect(await cloud.list({ instance: "running" })).toMatchObject([{ id: "running", type: "activated" }]);
  expect(bodies.length - before).toBe(1);
});
