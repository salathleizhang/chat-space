import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import type { Hono } from "hono";
import { createApp } from "../app";
import { LocalFileStorage, setAssetStorage } from "../services/assetStorage";

const root = await mkdtemp(join(tmpdir(), "gabo-library-test-"));
const storage = new LocalFileStorage(root);
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x01, 0x02]);
let app: Hono;

/** 真实可解析的最小 glb，供导出路由的 gltf/obj 转换测试用（跟静态服务测试用的假字节分开） */
async function buildRealGlb(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute("POSITION", position);
  const mesh = doc.createMesh().addPrimitive(prim);
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

beforeAll(async () => {
  setAssetStorage(storage);
  app = createApp();
  await storage.writeBytes("projects/demo/assets/crate/0-crate.glb", GLB_BYTES);
  await storage.writeBytes("projects/demo/assets/dog/0-dog.glb", await buildRealGlb());
});

afterAll(async () => {
  setAssetStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

describe("资产库静态服务", () => {
  test("按逻辑路径提供文件并带正确 content-type", async () => {
    const response = await app.request(
      "/api/library/projects/demo/assets/crate/0-crate.glb",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("model/gltf-binary");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(GLB_BYTES);
  });

  test("不存在的文件 404", async () => {
    const response = await app.request("/api/library/projects/demo/nope.glb");
    expect(response.status).toBe(404);
  });

  test("目录穿越被拒绝", async () => {
    const response = await app.request("/api/library/projects/../../etc/passwd");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("模型导出", () => {
  test("同格式原样直出，带下载头", async () => {
    const response = await app.request(
      "/api/library/export?source=projects/demo/assets/dog/0-dog.glb&format=glb",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain('filename="0-dog.glb"');
  });

  test("glb 转 gltf", async () => {
    const response = await app.request(
      "/api/library/export?source=projects/demo/assets/dog/0-dog.glb&format=gltf",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("model/gltf+json");
    const json = (await response.json()) as { asset: { version: string } };
    expect(json.asset.version).toBe("2.0");
  });

  test("glb 转 obj", async () => {
    const response = await app.request(
      "/api/library/export?source=projects/demo/assets/dog/0-dog.glb&format=obj",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("v ");
  });

  test("缺 source 参数报错", async () => {
    const response = await app.request("/api/library/export?format=glb");
    expect(response.status).toBe(400);
  });

  test("批量导出只选中一个资产时原样返回，不套 zip", async () => {
    const response = await app.request("/api/library/export-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({
        sources: ["projects/demo/assets/dog/0-dog.glb"],
        format: "obj",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toContain('filename="0-dog.obj"');
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("content-disposition");
    expect(await response.text()).toContain("v ");
  });

  test("批量导出打包成 zip，缺失文件跳过不拖垮整批", async () => {
    const response = await app.request("/api/library/export-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: ["projects/demo/assets/dog/0-dog.glb", "projects/demo/assets/nope/0-nope.glb"],
        format: "obj",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("批量导出全部失败时报错", async () => {
    const response = await app.request("/api/library/export-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: ["projects/demo/assets/nope/0-nope.glb"],
        format: "obj",
      }),
    });
    expect(response.status).toBe(422);
  });
});

describe("会话落盘", () => {
  test("保存 → 读取 → 列表（更新保留 createdAt）", async () => {
    const save = await app.request("/api/sessions/s-abc", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectSlug: "demo",
        title: "生成机械狗",
        messages: [{ id: "m1", role: "user", content: "生成一只机械狗" }],
        plan: {
          schemaVersion: 1,
          title: "生成机械狗",
          steps: [{ id: "step-1", content: "生成模型", status: "in_progress" }],
          updatedAt: "2026-08-01T06:00:00.000Z",
        },
      }),
    });
    expect(save.status).toBe(200);
    const first = ((await save.json()) as { session: { createdAt: string } }).session;

    const update = await app.request("/api/sessions/s-abc", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectSlug: "demo",
        title: "生成机械狗",
        messages: [
          { id: "m1", role: "user", content: "生成一只机械狗" },
          { id: "m2", role: "assistant", content: "好的，规划如下…" },
        ],
        plan: {
          schemaVersion: 1,
          title: "生成机械狗",
          steps: [{ id: "step-1", content: "生成模型", status: "completed" }],
          updatedAt: "2026-08-01T06:01:00.000Z",
        },
      }),
    });
    const updated = ((await update.json()) as { session: { createdAt: string } })
      .session;
    expect(updated.createdAt).toBe(first.createdAt);

    const get = await app.request("/api/sessions/s-abc");
    const session = ((await get.json()) as {
      session: { messages: unknown[]; plan?: { title?: string } };
    }).session;
    expect(session.messages).toHaveLength(2);
    expect(session.plan?.title).toBe("生成机械狗");

    const list = await app.request("/api/sessions?project=demo");
    const sessions = ((await list.json()) as {
      sessions: { id: string; messageCount: number }[];
    }).sessions;
    expect(sessions[0]?.id).toBe("s-abc");
    expect(sessions[0]?.messageCount).toBe(2);
  });
});
