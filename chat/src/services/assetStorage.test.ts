import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatServiceError } from "../common/errors";
import { projectFile } from "../common/libraryPaths";
import { ProjectSchema, RequestSidecarSchema } from "../dto/library";
import { LocalFileStorage, readAsDataUri, readJson, setInlineImageShrinker, writeJson } from "./assetStorage";

const root = await mkdtemp(join(tmpdir(), "chatspace-storage-test-"));
const storage = new LocalFileStorage(root);

afterAll(() => rm(root, { recursive: true, force: true }));

describe("LocalFileStorage", () => {
  test("写入自动建目录，读写往返一致", async () => {
    await storage.writeText("projects/demo/source/note.txt", "你好");
    expect(await storage.readText("projects/demo/source/note.txt")).toBe("你好");
    expect(await storage.exists("projects/demo/source/note.txt")).toBe(true);
  });

  test("list 返回子项，目录不存在返回空数组", async () => {
    expect(await storage.list("projects/demo/source")).toContain("note.txt");
    expect(await storage.list("projects/nope")).toEqual([]);
  });

  test("拒绝绝对路径与目录穿越", async () => {
    expect(storage.readText("/etc/passwd")).rejects.toThrow(ChatServiceError);
    expect(storage.readText("projects/../../escape")).rejects.toThrow(
      ChatServiceError,
    );
  });

  test("remove 幂等", async () => {
    await storage.writeText("projects/demo/tmp.txt", "x");
    await storage.remove("projects/demo/tmp.txt");
    await storage.remove("projects/demo/tmp.txt");
    expect(await storage.exists("projects/demo/tmp.txt")).toBe(false);
  });

  test("原子文本写入替换旧内容且不遗留临时文件", async () => {
    const path = "projects/atomic/project.json";
    await storage.writeText(path, "old");
    await storage.writeTextAtomic(path, "new");

    expect(await storage.readText(path)).toBe("new");
    expect(
      (await storage.list("projects/atomic")).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});

describe("JSON 契约读写", () => {
  test("writeJson 校验后落盘，readJson 校验后返回", async () => {
    const now = new Date().toISOString();
    const project = {
      schemaVersion: 1 as const,
      slug: "demo",
      name: "Demo 项目",
      createdAt: now,
      updatedAt: now,
    };
    await writeJson(storage, projectFile("demo"), ProjectSchema, project);
    const loaded = await readJson(storage, projectFile("demo"), ProjectSchema);
    expect(loaded).toEqual(project);
  });

  test("坏元数据读取时报 schema 不匹配", async () => {
    await storage.writeText("projects/bad/project.json", '{"slug":"bad"}');
    expect(
      readJson(storage, "projects/bad/project.json", ProjectSchema),
    ).rejects.toThrow("does not match the contract");
  });

  test("请求侧写拒绝密钥类字段（BYOK 纪律）", () => {
    const now = new Date().toISOString();
    const base = {
      schemaVersion: 1 as const,
      index: 0,
      slug: "arm",
      provider: "volcengine",
      model: "provider-3d",
      status: "queued" as const,
      outputs: [],
      createdAt: now,
      updatedAt: now,
    };
    expect(
      RequestSidecarSchema.safeParse({ ...base, params: { faceCount: 50000 } })
        .success,
    ).toBe(true);
    expect(
      RequestSidecarSchema.safeParse({ ...base, params: { apiKey: "sk-x" } })
        .success,
    ).toBe(false);
  });
});

/**
 * 图片内联的瘦身 hook。
 *
 * 这一条是给"请求体太大 → 跨境那一跳把它拖到分钟级 → 撞满 Vercel 300 秒上限"兜底的：
 * 浏览器构建装一个基于 OffscreenCanvas 的实现，其他运行时（Bun 本机服务、测试）不装，
 * 行为必须与改造前逐字一致。所以两条不变量最重要：**没装就原样**、**装坏了也原样**。
 */
describe("内联图片的瘦身 hook", () => {
  test("没装瘦身器时逐字回到原来的 data URI", async () => {
    await storage.writeBytes("projects/hook/source/tiny.png", new Uint8Array([1, 2, 3]));
    setInlineImageShrinker(undefined);
    expect(await readAsDataUri(storage, "projects/hook/source/tiny.png")).toBe(
      `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    );
  });

  test("装上瘦身器后按新字节与新 mime 内联", async () => {
    await storage.writeBytes("projects/hook/source/big.png", new Uint8Array(64));
    setInlineImageShrinker(async ({ bytes, mime, logicalPath }) => {
      expect(logicalPath).toBe("projects/hook/source/big.png");
      expect(mime).toBe("image/png");
      expect(bytes.byteLength).toBe(64);
      return { bytes: new Uint8Array([9]), mime: "image/jpeg" };
    });
    expect(await readAsDataUri(storage, "projects/hook/source/big.png")).toBe(
      `data:image/jpeg;base64,${Buffer.from([9]).toString("base64")}`,
    );
    setInlineImageShrinker(undefined);
  });

  test("瘦身器返回 undefined（缩小没收益/解不开）时回退原图", async () => {
    await storage.writeBytes("projects/hook/source/keep.png", new Uint8Array([7, 7]));
    setInlineImageShrinker(async () => undefined);
    expect(await readAsDataUri(storage, "projects/hook/source/keep.png")).toBe(
      `data:image/png;base64,${Buffer.from([7, 7]).toString("base64")}`,
    );
    setInlineImageShrinker(undefined);
  });

  test("模型文件不过瘦身器（它只处理图片）", async () => {
    await storage.writeBytes("projects/hook/source/mesh.glb", new Uint8Array([5]));
    let called = 0;
    setInlineImageShrinker(async () => {
      called += 1;
      return undefined;
    });
    await readAsDataUri(storage, "projects/hook/source/mesh.glb");
    expect(called).toBe(0);
    setInlineImageShrinker(undefined);
  });
});
