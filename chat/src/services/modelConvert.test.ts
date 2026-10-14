import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { ChatServiceError } from "../common/errors";
import { convertModel } from "./modelConvert";
import { LocalFileStorage } from "./assetStorage";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** 造一个带贴图的最小合法 glb，验证转换链路不依赖真实生成产物 */
async function buildSampleGlb(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const uv = doc
    .createAccessor()
    .setType("VEC2")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const texture = doc.createTexture("tex").setImage(new Uint8Array(PNG_1X1)).setMimeType("image/png");
  const material = doc.createMaterial("mat").setBaseColorTexture(texture);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("TEXCOORD_0", uv)
    .setMaterial(material);
  const mesh = doc.createMesh().addPrimitive(prim);
  const node = doc.createNode().setMesh(mesh);
  doc.createScene().addChild(node);
  return new NodeIO().writeBinary(doc);
}

const root = await mkdtemp(join(tmpdir(), "chatspace-convert-test-"));
const storage = new LocalFileStorage(root);
const glbBytes = await buildSampleGlb();
await storage.writeBytes("projects/demo/assets/crate/0-crate.glb", glbBytes);
await storage.writeBytes("projects/demo/assets/legacy/0-legacy.obj", new TextEncoder().encode("o legacy\n"));

describe("convertModel", () => {
  test("外部 glTF 导出内嵌 buffer 与贴图，脱离资产目录仍能还原几何和材质", async () => {
    const io = new NodeIO();
    const { json, resources } = await io.writeJSON(await io.readBinary(glbBytes));
    const bufferBytes = resources[json.buffers![0]!.uri!]!;
    const imageBytes = resources[json.images![0]!.uri!]!;
    const dir = "projects/demo/assets/external";
    await storage.writeBytes(`${dir}/mesh data.bin`, bufferBytes);
    await storage.writeBytes(`${dir}/textures/albedo.png`, imageBytes);
    json.buffers![0]!.uri = "mesh%20data.bin";
    json.images![0]!.uri = "textures/albedo.png";
    json.extras = { author: "keep-original-metadata" };
    await storage.writeText(`${dir}/0-external.gltf`, JSON.stringify(json));

    const result = await convertModel(storage, `${dir}/0-external.gltf`, "gltf");
    const exported = JSON.parse(new TextDecoder().decode(result.bytes));
    expect(exported.extras).toEqual(json.extras);
    expect(exported.buffers[0].uri).toStartWith("data:application/octet-stream;base64,");
    expect(exported.images[0].uri).toStartWith("data:image/png;base64,");
    // 只用下载的 JSON；不提供原始目录或任何外部资源。
    const restored = await io.readJSON({ json: exported, resources: {} });
    expect(Array.from(restored.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray()!))
      .toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(restored.getRoot().listTextures()[0]!.getImage()).toEqual(imageBytes);

    await storage.writeText(`${dir}/1-embedded.gltf`, JSON.stringify(exported));
    const embedded = await convertModel(storage, `${dir}/1-embedded.gltf`, "gltf");
    expect(JSON.parse(new TextDecoder().decode(embedded.bytes))).toEqual(exported);
  });

  test("glTF 缺少依赖时明确失败，不生成引用断裂的下载文件", async () => {
    const path = "projects/demo/assets/missing/0-missing.gltf";
    await storage.writeText(path, JSON.stringify({
      asset: { version: "2.0" }, buffers: [{ uri: "missing.bin", byteLength: 4 }],
    }));
    await expect(convertModel(storage, path, "gltf")).rejects.toThrow(
      "Export is missing a resource: missing.bin",
    );
  });

  test("glTF 导出拒绝网络 URL 和越出资产目录的资源", async () => {
    const path = "projects/demo/assets/invalid/0-invalid.gltf";
    for (const uri of ["https://example.com/image.png", "../private.bin", "%2e%2e/private.bin", "C:\\private.bin"]) {
      await storage.writeText(path, JSON.stringify({
        asset: { version: "2.0" }, buffers: [{ uri, byteLength: 4 }],
      }));
      await expect(convertModel(storage, path, "gltf")).rejects.toThrow(
        "Model resources must live inside the asset directory",
      );
    }
  });

  test("glb → glb 原样直出，不转换", async () => {
    const result = await convertModel(storage, "projects/demo/assets/crate/0-crate.glb", "glb");
    expect(result.fileName).toBe("0-crate.glb");
    expect(result.bytes).toEqual(glbBytes);
  });

  test("glb → gltf 无损重新打包，贴图内嵌为 data URI", async () => {
    const result = await convertModel(storage, "projects/demo/assets/crate/0-crate.glb", "gltf");
    expect(result.fileName).toBe("0-crate.gltf");
    const json = JSON.parse(new TextDecoder().decode(result.bytes));
    expect(json.buffers[0].uri).toStartWith("data:application/octet-stream;base64,");
    expect(json.images[0].uri).toStartWith("data:image/png;base64,");
  });

  test("glb → obj 走 three.js 场景图往返，产出几何", async () => {
    const result = await convertModel(storage, "projects/demo/assets/crate/0-crate.glb", "obj");
    expect(result.fileName).toBe("0-crate.obj");
    const text = new TextDecoder().decode(result.bytes);
    expect(text).toContain("v ");
  });

  test("非 glb 源资产转换报错，同格式仍可直出", async () => {
    const passthrough = await convertModel(storage, "projects/demo/assets/legacy/0-legacy.obj", "obj");
    expect(passthrough.fileName).toBe("0-legacy.obj");

    expect(
      convertModel(storage, "projects/demo/assets/legacy/0-legacy.obj", "glb"),
    ).rejects.toThrow(ChatServiceError);
  });

  afterAll(() => rm(root, { recursive: true, force: true }));
});
