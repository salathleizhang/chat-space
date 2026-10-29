import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { createProject } from "../mastra/tools/projectTools";
import { LocalFileStorage } from "./assetStorage";
import { runLocalTexture } from "./localTexture";

/** 1×1 透明 PNG：只用来验证字节被写进 GLB，不需要真的解码。 */
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

async function sphereGlb(segments = 16, rings = 8): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position: number[] = [];
  const uv: number[] = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      const phi = v * Math.PI;
      position.push(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
      uv.push(u, v);
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const primitive = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(position)).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(indices)).setBuffer(buffer));
  doc.createMesh().addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode().setMesh(doc.getRoot().listMeshes()[0]!));
  return new NodeIO().writeBinary(doc);
}

/** 假的双请求：一次生图（返回 URL），一次下载图片字节。 */
function fakeImageFetch(calls: string[]) {
  return (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/images/generations")) {
      return new Response(JSON.stringify({ data: [{ url: "https://img.test/tile.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(PNG_1X1, { status: 200, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;
}

describe("runLocalTexture", () => {
  let root: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "local-texture-"));
    storage = new LocalFileStorage(root);
    await createProject(storage, { name: "Texture", slug: "tex" });
    await storage.writeBytes("projects/tex/assets/ball/0-ball.glb", await sphereGlb());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("Seedream 出图 → 盒式投影 → 新一代 GLB 带贴图", async () => {
    const calls: string[] = [];
    const result = await runLocalTexture(storage, {
      projectSlug: "tex",
      assetSlug: "ball",
      prompt: "warm oak wood, matte",
      tiles: 2,
      volcengineApiKey: "ark-1",
      fetchFn: fakeImageFetch(calls),
    });

    // 生图一次 + 下载一次
    expect(calls.filter((url) => url.includes("/images/generations"))).toHaveLength(1);
    expect(calls.some((url) => url === "https://img.test/tile.png")).toBe(true);

    expect(result.model).toBe("projects/tex/assets/ball/1-ball.glb");
    expect(result.texture).toBe("projects/tex/assets/ball/1-ball-texture.png");
    expect(await storage.exists(result.texture)).toBe(true);

    const produced = await new NodeIO().readBinary(await storage.readBytes(result.model));
    for (const mesh of produced.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        expect(primitive.getAttribute("TEXCOORD_0")).not.toBeNull();
        expect(primitive.getMaterial()?.getBaseColorTexture()).not.toBeNull();
      }
    }
    expect(produced.getRoot().listTextures().length).toBeGreaterThan(0);
    // 原代次还在
    expect(await storage.exists("projects/tex/assets/ball/0-ball.glb")).toBe(true);
  });

  test("侧写记 local + seedream，输出含 glb 与 png", async () => {
    await runLocalTexture(storage, {
      projectSlug: "tex",
      assetSlug: "ball",
      prompt: "grey linen fabric",
      volcengineApiKey: "ark-1",
      fetchFn: fakeImageFetch([]),
    });
    const sidecar = JSON.parse(
      await storage.readText("projects/tex/assets/ball/.1-ball-request.json"),
    );
    expect(sidecar.provider).toBe("local");
    expect(sidecar.model).toBe("seedream-texture");
    expect(sidecar.outputs.map((entry: { path: string }) => entry.path)).toContain(
      "projects/tex/assets/ball/1-ball.glb",
    );
  });

  test("材质描述为空时拒绝，不打生图请求", async () => {
    const calls: string[] = [];
    await expect(
      runLocalTexture(storage, {
        projectSlug: "tex",
        assetSlug: "ball",
        prompt: "   ",
        volcengineApiKey: "ark-1",
        fetchFn: fakeImageFetch(calls),
      }),
    ).rejects.toThrow(/material/i);
    expect(calls).toHaveLength(0);
  });

  test("平铺次数越界时拒绝", async () => {
    await expect(
      runLocalTexture(storage, {
        projectSlug: "tex",
        assetSlug: "ball",
        prompt: "oak",
        tiles: 99,
        volcengineApiKey: "ark-1",
        fetchFn: fakeImageFetch([]),
      }),
    ).rejects.toThrow(/1–32/);
  });
});
