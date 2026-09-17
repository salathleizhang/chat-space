import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetIdentityFile, projectSourceDir } from "../../common/libraryPaths";
import { AssetIdentitySchema, RequestSidecarSchema } from "../../dto/library";
import {
  LocalFileStorage,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { repairProjectAssets } from "./assetRepair";
import { runFalImageEdit } from "./falImageEdit";
import { writePlan } from "./planTools";
import {
  activateEnvironmentAsset,
  createProject,
  deleteAsset,
  getProjectState,
  listProjects,
  saveAssetThumbnail,
  setCurrentSkybox,
  setCurrentWorld,
  slugify,
  writeSceneTransforms,
} from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-tools-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

afterAll(() => rm(root, { recursive: true, force: true }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 模拟 FAL 队列 + 产物 CDN */
function makeFakeFetch(options?: { failSubmit?: boolean }) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://cdn.fake/out.png") {
      return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
    }
    if (url.endsWith("/status")) return jsonResponse({ status: "COMPLETED" });
    if (url.includes("/requests/")) {
      return jsonResponse({
        images: [{ url: "https://cdn.fake/out.png", content_type: "image/png" }],
      });
    }
    if (options?.failSubmit) return jsonResponse({ detail: "invalid key" }, 401);
    return jsonResponse({ request_id: "req-42" });
  }) as typeof fetch;
}

describe("projectTools", () => {
  test("slugify 中英混输", () => {
    expect(slugify("My Cyber-Dog 01")).toBe("my-cyber-dog-01");
  });

  test("创建项目 → 列表 → 派生状态", async () => {
    const project = await createProject(storage, { name: "Demo World", slug: "demo" });
    expect(project.slug).toBe("demo");
    expect((await listProjects(storage)).map((p) => p.slug)).toContain("demo");

    const state = await getProjectState(storage, "demo");
    expect(state.sources).toEqual([]);
    expect(state.generatedReferences).toEqual([]);
    expect(state.nextSourceIndex).toBe(0);
    expect(state.hasAnalysis).toBe(false);
    expect(state.assets).toEqual([]);
  });

  test("重复创建同 slug 报 409", () => {
    expect(createProject(storage, { name: "Demo", slug: "demo" })).rejects.toThrow(
      "已存在",
    );
  });

  test("项目状态只列出为 3D 生成的参考图", async () => {
    await createProject(storage, { name: "Reference List", slug: "reference-list" });
    const sourceDir = projectSourceDir("reference-list");
    const createdAt = "2026-07-31T00:00:00.000Z";
    const referencePath = `${sourceDir}/1-chair-ref.png`;
    const platePath = `${sourceDir}/2-plate.png`;
    await storage.writeBytes(`${sourceDir}/0-upload.png`, PNG_BYTES);
    await storage.writeBytes(referencePath, PNG_BYTES);
    await storage.writeBytes(platePath, PNG_BYTES);
    await writeJson(
      storage,
      `${sourceDir}/.1-chair-ref-request.json`,
      RequestSidecarSchema,
      {
        schemaVersion: 1,
        index: 1,
        slug: "chair-ref",
        provider: "fal",
        model: "seedream",
        params: { prompt: "chair", count: 1, asset_slug: "chair" },
        status: "succeeded",
        outputs: [{ path: referencePath }],
        createdAt,
        updatedAt: createdAt,
      },
    );
    await writeJson(
      storage,
      `${sourceDir}/.2-plate-request.json`,
      RequestSidecarSchema,
      {
        schemaVersion: 1,
        index: 2,
        slug: "plate",
        provider: "fal",
        model: "nano-banana",
        params: { prompt: "remove objects", role: "plate" },
        status: "succeeded",
        outputs: [{ path: platePath }],
        createdAt,
        updatedAt: createdAt,
      },
    );

    expect((await getProjectState(storage, "reference-list")).generatedReferences).toEqual([
      referencePath,
    ]);
  });
});

describe("saveAssetThumbnail", () => {
  const dir = "projects/demo/assets/chair";

  test("落盘 .thumb-<源产物名>.png，且不进派生状态的可见产物清单", async () => {
    await storage.writeBytes(`${dir}/3-chair.glb`, PNG_BYTES);
    await writeJson(storage, assetIdentityFile("demo", "chair"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "chair",
      kind: "model",
      name: "椅子",
      intent: "测试椅子",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    const { path } = await saveAssetThumbnail(storage, {
      projectSlug: "demo",
      assetSlug: "chair",
      sourceFile: "3-chair.glb",
      bytes: PNG_BYTES,
    });
    expect(path).toBe(`${dir}/.thumb-3-chair.png`);
    expect(await storage.readBytes(path)).toEqual(PNG_BYTES);

    // 隐藏文件仍出现在 files 里（过滤在 app 侧派生），但名字带 . 前缀可被识别
    const state = await getProjectState(storage, "demo");
    const asset = state.assets.find((a) => a.slug === "chair");
    expect(asset?.files).toContain(".thumb-3-chair.png");
  });

  test("换代后新旧缩略图各自独立，不覆盖", async () => {
    await storage.writeBytes(`${dir}/4-chair.glb`, PNG_BYTES);
    const { path } = await saveAssetThumbnail(storage, {
      projectSlug: "demo",
      assetSlug: "chair",
      sourceFile: "4-chair.glb",
      bytes: PNG_BYTES,
    });
    expect(path).toBe(`${dir}/.thumb-4-chair.png`);
    expect(await storage.exists(`${dir}/.thumb-3-chair.png`)).toBe(true);
  });

  test("天空盒以 HDR 环境贴图为源产物（app 端渲的是贴了这张图的球）", async () => {
    const skyDir = "projects/demo/assets/sky";
    await storage.writeBytes(`${skyDir}/1-sky.hdr`, PNG_BYTES);
    const { path } = await saveAssetThumbnail(storage, {
      projectSlug: "demo",
      assetSlug: "sky",
      sourceFile: "1-sky.hdr",
      bytes: PNG_BYTES,
    });
    expect(path).toBe(`${skyDir}/.thumb-1-sky.png`);
  });

  test("拒绝路径注入型源产物名、非模型后缀、空内容与不存在的源产物", async () => {
    const base = { projectSlug: "demo", assetSlug: "chair", bytes: PNG_BYTES };
    await expect(
      saveAssetThumbnail(storage, { ...base, sourceFile: "../../escape.glb" }),
    ).rejects.toThrow(/不合法/);
    await expect(
      saveAssetThumbnail(storage, { ...base, sourceFile: "3-chair.png" }),
    ).rejects.toThrow(/不合法/);
    await expect(
      saveAssetThumbnail(storage, { ...base, sourceFile: "chair.glb" }),
    ).rejects.toThrow(/不合法/);
    await expect(
      saveAssetThumbnail(storage, {
        ...base,
        sourceFile: "3-chair.glb",
        bytes: new Uint8Array(0),
      }),
    ).rejects.toThrow(/为空/);
    await expect(
      saveAssetThumbnail(storage, { ...base, sourceFile: "9-missing.glb" }),
    ).rejects.toThrow(/不存在/);
  });
});

describe("runFalImageEdit", () => {
  test("生成 plate：产物落盘为新源图索引 + 侧写完整且无密钥", async () => {
    const sourceDir = projectSourceDir("demo");
    await storage.writeBytes(`${sourceDir}/0-photo.png`, PNG_BYTES);

    const result = await runFalImageEdit(
      storage,
      {
        projectSlug: "demo",
        images: [`${sourceDir}/0-photo.png`],
        prompt: "remove the dog, only removal",
        role: "plate",
        model: "nano-banana",
        resolution: "1K",
        aspectRatio: "auto",
        outputFormat: "png",
      },
      { falApiKey: "sk-secret-do-not-persist" },
      { fetchFn: makeFakeFetch(), pollIntervalMs: 1 },
    );

    expect(result.output).toBe(`${sourceDir}/1-plate.png`);
    expect(await storage.exists(result.output)).toBe(true);

    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.status).toBe("succeeded");
    expect(sidecar.providerTaskId).toBe("req-42");
    expect(sidecar.outputs[0]?.providerUrl).toBe("https://cdn.fake/out.png");
    expect(await storage.readText(result.sidecar)).not.toContain(
      "sk-secret-do-not-persist",
    );

    const state = await getProjectState(storage, "demo");
    expect(state.sources).toContain("1-plate.png");
    expect(state.nextSourceIndex).toBe(2);
  });

  test("提交失败：侧写记为 failed 并携带错误", async () => {
    const sourceDir = projectSourceDir("demo");
    expect(
      runFalImageEdit(
        storage,
        {
          projectSlug: "demo",
          images: [`${sourceDir}/0-photo.png`],
          prompt: "x",
          role: "edit",
          model: "nano-banana",
          resolution: "1K",
          aspectRatio: "auto",
          outputFormat: "png",
        },
        { falApiKey: "bad" },
        { fetchFn: makeFakeFetch({ failSubmit: true }), pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("FAL 提交失败");

    const sidecar = await readJson(
      storage,
      `${sourceDir}/.2-edit-request.json`,
      RequestSidecarSchema,
    );
    expect(sidecar.status).toBe("failed");
    expect(sidecar.error).toContain("FAL 提交失败");
  });
});

describe("repairProjectAssets", () => {
  test("删除产物后按侧写回填，不产生新索引", async () => {
    const sourceDir = projectSourceDir("demo");
    await storage.remove(`${sourceDir}/1-plate.png`);
    expect(await storage.exists(`${sourceDir}/1-plate.png`)).toBe(false);

    const report = await repairProjectAssets(storage, "demo", {
      fetchFn: makeFakeFetch(),
    });
    expect(report.repaired).toEqual([`${sourceDir}/1-plate.png`]);
    expect(await storage.exists(`${sourceDir}/1-plate.png`)).toBe(true);

    // 修复只回填，不产生新索引：failed 的 .2-edit 侧写仍占位，下一索引保持 3
    const state = await getProjectState(storage, "demo");
    expect(state.nextSourceIndex).toBe(3);
  });

  test("再次修复无事可做", async () => {
    const report = await repairProjectAssets(storage, "demo", {
      fetchFn: makeFakeFetch(),
    });
    expect(report.repaired).toEqual([]);
    expect(report.checkedSidecars).toBeGreaterThan(0);
  });
});

describe("writePlan", () => {
  test("首次创建后只按稳定 id 更新状态，结构与版本保持不变", async () => {
    await writePlan(storage, "demo", {
      title: "一图成场景",
      steps: [
        { id: "plate", content: "生成干净底板" },
        { id: "batch-3d", content: "批量 3D 生成" },
      ],
    });
    const state = await getProjectState(storage, "demo");
    expect(state.plan?.title).toBe("一图成场景");
    expect(state.plan?.revision).toBe(1);
    expect(state.plan?.steps.map((s) => s.status)).toEqual(["pending", "pending"]);

    await writePlan(storage, "demo", {
      steps: [
        { id: "plate", content: "生成干净底板", status: "completed" },
        { id: "batch-3d", content: "批量 3D 生成", status: "in_progress" },
      ],
    });
    const updated = await getProjectState(storage, "demo");
    expect(updated.plan?.title).toBe("一图成场景");
    expect(updated.plan?.revision).toBe(1);
    expect(updated.plan?.steps.map((s) => s.id)).toEqual(["plate", "batch-3d"]);
    expect(updated.plan?.steps.map((s) => s.status)).toEqual([
      "completed",
      "in_progress",
    ]);
  });

  test("继续执行不能改写步骤；显式 replan 才能换结构并记录原因", async () => {
    expect(
      writePlan(storage, "demo", {
        steps: [{ id: "batch-3d", content: "换一种说法", status: "completed" }],
      }),
    ).rejects.toThrow("不能改写步骤");

    const replanned = await writePlan(storage, "demo", {
      mode: "replan",
      reason: "供应商不支持目标格式，改走本地 CAD",
      title: "改用 CAD",
      steps: [{ id: "cad", content: "构建 CAD 模型", status: "in_progress" }],
    });
    expect(replanned.revision).toBe(2);
    expect(replanned.revisionReason).toContain("供应商不支持");
    expect(replanned.steps.map((step) => step.id)).toEqual(["cad"]);
  });

  test("已完成步骤不能在普通更新里回退", async () => {
    await writePlan(storage, "demo", {
      steps: [{ id: "cad", status: "completed" }],
    });
    expect(
      writePlan(storage, "demo", {
        steps: [{ id: "cad", status: "in_progress" }],
      }),
    ).rejects.toThrow("不能回退");
  });

  test("项目不存在时报 404", () => {
    expect(
      writePlan(storage, "nope", { steps: [{ id: "a", content: "x" }] }),
    ).rejects.toThrow("不存在");
  });
});

describe("deleteAsset", () => {
  test("整个资产目录连同产物移除，派生状态里不再有它", async () => {
    const dir = "projects/demo/assets/doomed";
    await storage.writeBytes(`${dir}/0-doomed.glb`, PNG_BYTES);
    await storage.writeBytes(`${dir}/.thumb-0-doomed.png`, PNG_BYTES);
    await writeJson(storage, assetIdentityFile("demo", "doomed"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "doomed",
      kind: "model",
      name: "待删除模型",
      intent: "测试删除",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    expect((await getProjectState(storage, "demo")).assets.map((a) => a.slug)).toContain(
      "doomed",
    );

    const { deleted } = await deleteAsset(storage, "demo", "doomed");
    expect(deleted).toBe(dir);
    expect(await storage.exists(`${dir}/0-doomed.glb`)).toBe(false);
    expect(
      (await getProjectState(storage, "demo")).assets.map((a) => a.slug),
    ).not.toContain("doomed");
  });

  test("删掉的正是当前天空盒时清掉项目单例指针", async () => {
    await storage.writeBytes("projects/demo/assets/sky/0-sky.hdr", PNG_BYTES);
    await setCurrentSkybox(storage, "demo", "sky");
    expect((await getProjectState(storage, "demo")).project.currentSkybox).toBe("sky");

    await deleteAsset(storage, "demo", "sky");
    expect(
      (await getProjectState(storage, "demo")).project.currentSkybox,
    ).toBeUndefined();
  });

  test("删掉当前 World 时只清 World 指针，保留当前天空盒", async () => {
    await storage.writeBytes("projects/demo/assets/sky-keep/0-sky-keep.hdr", PNG_BYTES);
    await storage.writeBytes("projects/demo/assets/world-active/0-world-active.spz", PNG_BYTES);
    await setCurrentSkybox(storage, "demo", "sky-keep");
    await setCurrentWorld(storage, "demo", "world-active");

    await deleteAsset(storage, "demo", "world-active");
    const project = (await getProjectState(storage, "demo")).project;
    expect(project.currentWorld).toBeUndefined();
    expect(project.currentSkybox).toBe("sky-keep");
  });

  test("资产不存在报 404，项目不存在报 404", async () => {
    await expect(deleteAsset(storage, "demo", "nope")).rejects.toThrow("不存在");
    await expect(deleteAsset(storage, "no-such-project", "chair")).rejects.toThrow(
      "不存在",
    );
  });

  test("顺手摘掉被删资产的场景摆放，同名 slug 重新导入不会继承旧位置", async () => {
    await storage.writeBytes("projects/demo/assets/stool/0-stool.glb", PNG_BYTES);
    await writeSceneTransforms(storage, "demo", {
      stool: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      keeper: { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    await deleteAsset(storage, "demo", "stool");
    const scene = (await getProjectState(storage, "demo")).scene;
    expect(scene?.transforms.stool).toBeUndefined();
    expect(scene?.transforms.keeper?.position).toEqual([9, 9, 9]);
  });
});

describe("activateEnvironmentAsset", () => {
  test("天空盒与 World 各自切换；null 恢复默认天空盒", async () => {
    const now = new Date().toISOString();
    await writeJson(
      storage,
      "projects/demo/assets/blue-sky/asset.json",
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        slug: "blue-sky",
        kind: "skybox",
        name: "蓝天",
        intent: "blue sky",
        sourceImages: [],
        createdAt: now,
      },
    );
    await writeJson(
      storage,
      "projects/demo/assets/forest/asset.json",
      AssetIdentitySchema,
      {
        schemaVersion: 1,
        slug: "forest",
        kind: "world",
        name: "森林",
        intent: "forest",
        sourceImages: [],
        createdAt: now,
      },
    );

    await activateEnvironmentAsset(storage, "demo", "skybox", "blue-sky");
    await activateEnvironmentAsset(storage, "demo", "world", "forest");
    let project = (await getProjectState(storage, "demo")).project;
    expect(project.currentSkybox).toBe("blue-sky");
    expect(project.currentWorld).toBe("forest");

    await activateEnvironmentAsset(storage, "demo", "skybox", undefined);
    project = (await getProjectState(storage, "demo")).project;
    expect(project.currentSkybox).toBeUndefined();
    expect(project.currentWorld).toBe("forest");
  });

  test("拒绝不存在的资产和 kind 不匹配", async () => {
    await expect(
      activateEnvironmentAsset(storage, "demo", "world", "missing"),
    ).rejects.toThrow("不存在");
    await expect(
      activateEnvironmentAsset(storage, "demo", "world", "blue-sky"),
    ).rejects.toThrow("不是世界资产");
  });
});

describe("project.json mutations", () => {
  test("同文件更新串行，但 project.json 与 scene.json 互不阻塞", async () => {
    await createProject(storage, { name: "并发环境", slug: "environment-race" });
    let activeMetadataWrites = 0;
    let maxMetadataWrites = 0;
    const delayedStorage: AssetStorage = {
      readText: (path) => storage.readText(path),
      readBytes: (path) => storage.readBytes(path),
      writeText: (path, text) => storage.writeText(path, text),
      writeBytes: (path, bytes) => storage.writeBytes(path, bytes),
      list: (path) => storage.list(path),
      exists: (path) => storage.exists(path),
      remove: (path) => storage.remove(path),
      writeTextAtomic: async (path, text) => {
        const delayed =
          path.endsWith("/project.json") || path.endsWith("/scene.json");
        if (delayed) {
          activeMetadataWrites += 1;
          maxMetadataWrites = Math.max(maxMetadataWrites, activeMetadataWrites);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        try {
          await storage.writeTextAtomic(path, text);
        } finally {
          if (delayed) activeMetadataWrites -= 1;
        }
      },
    };

    await Promise.all([
      setCurrentSkybox(delayedStorage, "environment-race", "blue-sky"),
      setCurrentWorld(delayedStorage, "environment-race", "forest"),
      writeSceneTransforms(delayedStorage, "environment-race", {
        chair: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
    ]);

    const state = await getProjectState(storage, "environment-race");
    expect(maxMetadataWrites).toBe(2);
    expect(state.project.currentSkybox).toBe("blue-sky");
    expect(state.project.currentWorld).toBe("forest");
  });
});

describe("writeSceneTransforms", () => {
  test("合并写入：只提交动过的资产，其余条目原样保留", async () => {
    await createProject(storage, { name: "摆放", slug: "layout-demo" });
    await writeSceneTransforms(storage, "layout-demo", {
      chair: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      table: { position: [0, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    await writeSceneTransforms(storage, "layout-demo", {
      chair: { position: [5, 0, 5], rotation: [0, Math.PI, 0], scale: [2, 2, 2] },
    });

    const scene = (await getProjectState(storage, "layout-demo")).scene;
    expect(scene?.transforms.chair).toEqual({
      position: [5, 0, 5],
      rotation: [0, Math.PI, 0],
      scale: [2, 2, 2],
    });
    // 这一轮没提交 table，它必须还在
    expect(scene?.transforms.table?.position).toEqual([0, 0, 2]);
  });

  test("没有 scene.json 时派生状态里就没有 scene 字段", async () => {
    await createProject(storage, { name: "空摆放", slug: "layout-empty" });
    expect((await getProjectState(storage, "layout-empty")).scene).toBeUndefined();
  });

  test("并发窗口的读改写按项目串行，不丢任何一方的摆位", async () => {
    await createProject(storage, { name: "并发摆放", slug: "layout-race" });
    let activeSceneWrites = 0;
    let maxSceneWrites = 0;
    const delayedStorage: AssetStorage = {
      readText: (path) => storage.readText(path),
      readBytes: (path) => storage.readBytes(path),
      writeBytes: (path, bytes) => storage.writeBytes(path, bytes),
      list: (path) => storage.list(path),
      exists: (path) => storage.exists(path),
      remove: (path) => storage.remove(path),
      writeText: (path, text) => storage.writeText(path, text),
      writeTextAtomic: async (path, text) => {
        if (path.endsWith("/scene.json")) {
          activeSceneWrites += 1;
          maxSceneWrites = Math.max(maxSceneWrites, activeSceneWrites);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        try {
          await storage.writeTextAtomic(path, text);
        } finally {
          if (path.endsWith("/scene.json")) activeSceneWrites -= 1;
        }
      },
    };

    await Promise.all([
      writeSceneTransforms(delayedStorage, "layout-race", {
        chair: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
      writeSceneTransforms(delayedStorage, "layout-race", {
        table: { position: [0, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
    ]);

    const scene = (await getProjectState(storage, "layout-race")).scene;
    expect(maxSceneWrites).toBe(1);
    expect(scene?.transforms.chair?.position).toEqual([1, 0, 0]);
    expect(scene?.transforms.table?.position).toEqual([0, 0, 2]);
  });

  test("项目不存在报 404", async () => {
    await expect(writeSceneTransforms(storage, "no-such-project", {})).rejects.toThrow(
      "不存在",
    );
  });
});
