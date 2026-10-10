import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BlenderCloudClient, assertBlenderProject } from "./blenderCloud";
import { setBlenderMcp } from "./blenderMcp";
import { runBlenderExport } from "../mastra/tools/blenderOps";
import { createProject } from "../mastra/tools/projectTools";
import { LocalFileStorage } from "../services/assetStorage";

function smallGlb(): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" },
    meshes: [{ primitives: [{ indices: 0 }] }], accessors: [{ count: 36 }], extras: { padding: "x".repeat(1100) } }));
  const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(32);
  padded.set(json);
  const result = new Uint8Array(20 + padded.length);
  const view = new DataView(result.buffer);
  for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, result.length], [12, padded.length], [16, 0x4e4f534a]])
    view.setUint32(offset!, value!, true);
  result.set(padded, 20);
  return result;
}

test("cloud GLB is downloaded, published and cleaned up without a local Blender mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatspace-cloud-export-test-"));
  const storage = new LocalFileStorage(root);
  const requests: string[] = [];
  let remotePath = "";
  const bytes = smallGlb();
  const client = new BlenderCloudClient({ target: "https://gateway.example/", token: "Test_Control_Token_1234567890123456",
    instanceName: "sandbox-test", projectSlug: "export-test" }, (async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push(`${init?.method} ${path}`);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "GET") return new Response(bytes);
      const input = JSON.parse(init!.body as string);
      if (input.tool === "export_scene") remotePath = input.arguments.filepath;
      return Response.json({ content: [{ type: "text", text: JSON.stringify(input.tool === "get_addon_status" ?
        { blender_version: "5.2.2" } : { path: remotePath }) }] });
    }) as typeof fetch);
  try {
    await createProject(storage, { name: "Cloud export", slug: "export-test" });
    setBlenderMcp(client);
    const result = await runBlenderExport(storage, "export-test", { assetSlug: "cube-test" });
    expect(result.faces).toBe(12);
    expect(result.blenderVersion).toBe("5.2.2");
    expect(await storage.readBytes(result.glbPath)).toEqual(bytes);
    const sidecar = JSON.parse(await storage.readText(result.sidecarPath));
    expect(sidecar.status).toBe("succeeded");
    expect(remotePath).toMatch(/^\/workspace\/\.chatspace\/exports\/[0-9a-f-]+\/model\.glb$/);
    expect(requests.filter((path) => path.startsWith("GET /control/exports/"))).toHaveLength(1);
    expect(requests.at(-1)).toMatch(/^DELETE \/control\/exports\//);
  } finally {
    setBlenderMcp(null);
    await rm(root, { recursive: true, force: true });
  }
});

test("a configured cloud instance rejects a different project before tool execution", () => {
  const keys = ["BLENDER_LIVE_TARGET", "BLENDER_LIVE_INSTANCE_NAME", "BLENDER_CONTROL_TOKEN", "BLENDER_CLOUD_PROJECT"] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    process.env.BLENDER_LIVE_TARGET = "https://gateway.example/";
    process.env.BLENDER_LIVE_INSTANCE_NAME = "sandbox-test";
    process.env.BLENDER_CONTROL_TOKEN = "Test_Control_Token_1234567890123456";
    process.env.BLENDER_CLOUD_PROJECT = "p-one";
    expect(() => assertBlenderProject("p-two")).toThrow("另一个工程");
    expect(() => assertBlenderProject("p-one")).not.toThrow();
  } finally {
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  }
});
