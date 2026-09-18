import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatServiceError } from "../common/errors";
import { projectFile } from "../common/libraryPaths";
import { ProjectSchema, RequestSidecarSchema } from "../dto/library";
import { LocalFileStorage, readJson, writeJson } from "./assetStorage";

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
    ).rejects.toThrow("不符合契约");
  });

  test("请求侧写拒绝密钥类字段（BYOK 纪律）", () => {
    const now = new Date().toISOString();
    const base = {
      schemaVersion: 1 as const,
      index: 0,
      slug: "arm",
      provider: "volcengine",
      model: "hunyuan-3d",
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
