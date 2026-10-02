import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDir, assetIdentityFile, projectSourceDir } from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  RequestSidecarSchema,
  SCENE_SCHEMA_VERSION,
  assetStableId,
  createAssetIdentity,
  type AssetTransform,
} from "../../dto/library";
import {
  LocalFileStorage,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { repairProjectAssets } from "./assetRepair";
import { runLibraryImageEdit } from "./imageEdit";
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
  writeSceneLayout,
  writeSceneTransforms,
} from "./projectTools";

const root = await mkdtemp(join(tmpdir(), "chatspace-tools-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

afterAll(() => rm(root, { recursive: true, force: true }));

/**
 * 场景表的键（资产稳定 id）。这些用例大多没有真实的 asset.json，资产的 id 就退化成
 * slug 派生值（与 `assetStableId` 的规则一致）。所有场景表读写都走它，别在测试里写裸 slug——
 * 那测的就不是生产里发生的事了。
 */
const sceneKey = (slug: string) => `slug:${slug}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 模拟方舟图片接口与产物 CDN */
function makeFakeFetch(options?: { failSubmit?: boolean }) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://cdn.fake/out.png") {
      return new Response(PNG_BYTES.buffer.slice(0), { status: 200 });
    }
    if (options?.failSubmit) return jsonResponse({ detail: "invalid key" }, 401);
    return jsonResponse({ data: [{ url: "https://cdn.fake/out.png" }] });
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

  test("world 资产带上渲染对齐参数；flip_y 缺失时缺省翻转", async () => {
    await createProject(storage, { name: "World Semantics", slug: "world-semantics" });
    const dir = assetDir("world-semantics", "world");
    await writeJson(storage, assetIdentityFile("world-semantics", "world"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "world",
      kind: "world",
      name: "world",
      intent: "test world",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    // 真实响应就长这样：有缩放与地面偏移，但**没有** flip_y（Marble 取默认值时省略）
    await storage.writeText(
      `${dir}/0-world.json`,
      JSON.stringify({
        world_id: "w-1",
        assets: {
          splats: {
            semantics_metadata: {
              metric_scale_factor: 2.6222534,
              ground_plane_offset: 1.5924374,
            },
          },
        },
      }),
    );

    const state = await getProjectState(storage, "world-semantics");
    expect(state.assets.find((a) => a.slug === "world")?.worldSemantics).toEqual({
      flipY: true,
      metricScaleFactor: 2.6222534,
      groundPlaneOffset: 1.5924374,
    });
  });

  test("非 world 资产不带对齐参数；世界 JSON 损坏也不拖垮项目状态", async () => {
    await createProject(storage, { name: "Broken World", slug: "broken-world" });
    const dir = assetDir("broken-world", "world");
    await writeJson(storage, assetIdentityFile("broken-world", "world"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "world",
      kind: "world",
      name: "world",
      intent: "test world",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    await storage.writeText(`${dir}/0-world.json`, "{ not json");

    const state = await getProjectState(storage, "broken-world");
    // 读不出来就不给字段，由 app 用缺省值兜底（缺省同样是翻转）
    expect(state.assets.find((a) => a.slug === "world")?.worldSemantics).toBeUndefined();
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
        provider: "volcengine",
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
        provider: "volcengine",
        model: "seedream",
        params: { prompt: "remove objects", role: "plate" },
        status: "succeeded",
        outputs: [{ path: platePath }],
        createdAt,
        updatedAt: createdAt,
      },
    );

    expect((await getProjectState(storage, "reference-list")).generatedReferences).toEqual([
      { path: referencePath, generatedAt: createdAt },
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

    await writeJson(storage, assetIdentityFile("demo", "sky"), AssetIdentitySchema, {
      schemaVersion: 1,
      slug: "sky",
      kind: "skybox",
      name: "Sky",
      intent: "edited skybox",
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
    await storage.writeBytes(`${skyDir}/2-sky.png`, PNG_BYTES);
    const edited = await saveAssetThumbnail(storage, {
      projectSlug: "demo",
      assetSlug: "sky",
      sourceFile: "2-sky.png",
      bytes: PNG_BYTES,
    });
    expect(edited.path).toBe(`${skyDir}/.thumb-2-sky.png`);
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

describe("runLibraryImageEdit", () => {
  test("生成 plate：产物落盘为新源图索引 + 侧写完整且无密钥", async () => {
    const sourceDir = projectSourceDir("demo");
    await storage.writeBytes(`${sourceDir}/0-photo.png`, PNG_BYTES);

    const result = await runLibraryImageEdit(
      storage,
      {
        projectSlug: "demo",
        images: [`${sourceDir}/0-photo.png`],
        prompt: "remove the dog, only removal",
        role: "plate",
        model: "seedream",
        outputFormat: "png",
      },
      { volcengineApiKey: "sk-secret-do-not-persist" },
      { fetchFn: makeFakeFetch() },
    );

    expect(result.output).toBe(`${sourceDir}/1-plate.png`);
    expect(await storage.exists(result.output)).toBe(true);

    const sidecar = await readJson(storage, result.sidecar, RequestSidecarSchema);
    expect(sidecar.status).toBe("succeeded");
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
      runLibraryImageEdit(
        storage,
        {
          projectSlug: "demo",
          images: [`${sourceDir}/0-photo.png`],
          prompt: "x",
          role: "edit",
          model: "seedream",
          outputFormat: "png",
        },
        { volcengineApiKey: "bad" },
        { fetchFn: makeFakeFetch({ failSubmit: true }) },
      ),
    ).rejects.toThrow("图片生成失败");

    const sidecar = await readJson(
      storage,
      `${sourceDir}/.2-edit-request.json`,
      RequestSidecarSchema,
    );
    expect(sidecar.status).toBe("failed");
    expect(sidecar.error).toContain("图片生成失败");
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

  test("已提交但没跑完的侧写归入 resumable，提示先续跑而不是重新提交", async () => {
    const sourceDir = projectSourceDir("demo");
    const pending = `${sourceDir}/.9-pending-thing-request.json`;
    await writeJson(storage, pending, RequestSidecarSchema, {
      schemaVersion: 1,
      index: 9,
      slug: "pending-thing",
      provider: "tripo",
      model: "v3/generation/image-to-model",
      providerTaskId: "tripo-task-9",
      params: { generation_mode: "single" },
      status: "running",
      outputs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const report = await repairProjectAssets(storage, "demo", {
      fetchFn: makeFakeFetch(),
    });
    expect(report.resumable).toContain(pending);
    // 已成功的侧写不该被当成待续跑
    expect(report.resumable).not.toContain(`${sourceDir}/.1-plate-request.json`);

    await storage.remove(pending);
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

  test("普通进度更新不能改标题；改名必须走 replan", async () => {
    expect(
      writePlan(storage, "demo", {
        title: "换一个说法",
        steps: [{ id: "batch-3d", status: "in_progress" }],
      }),
    ).rejects.toThrow("不能改计划标题");

    const state = await getProjectState(storage, "demo");
    expect(state.plan?.title).toBe("一图成场景");
    expect(state.plan?.revision).toBe(1);
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

  test("顺手摘掉被删资产的场景摆放，其余条目原样保留", async () => {
    await storage.writeBytes("projects/demo/assets/stool/0-stool.glb", PNG_BYTES);
    await writeSceneTransforms(storage, "demo", {
      [sceneKey("stool")]: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      [sceneKey("keeper")]: { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    await deleteAsset(storage, "demo", "stool");
    const scene = (await getProjectState(storage, "demo")).scene;
    expect(scene?.transforms[sceneKey("stool")]).toBeUndefined();
    expect(scene?.transforms[sceneKey("keeper")]?.position).toEqual([9, 9, 9]);
  });

  /**
   * 这条锁的是"结构上不继承"，而不是"删除时清理得干净"：故意绕过 cleanup，只把目录换成
   * 一个同 slug 的新资产。旧记录仍在文件里，但新资产的身份是新的，所以它读不到——
   * 哪怕清理那一步整个没跑，也不会串。
   */
  test("同名 slug 重建不继承旧记录：隔离来自稳定 id，不是删除时的清理", async () => {
    const identity = (name: string) =>
      createAssetIdentity({
        slug: "stool",
        kind: "model",
        name,
        intent: "a stool",
        sourceImages: [],
      });

    const publishStool = async (name: string) => {
      await storage.writeBytes("projects/demo/assets/stool/0-stool.glb", PNG_BYTES);
      await writeJson(storage, assetIdentityFile("demo", "stool"), AssetIdentitySchema, identity(name));
      const state = await getProjectState(storage, "demo");
      const asset = state.assets.find((entry) => entry.slug === "stool");
      expect(asset).toBeDefined();
      return assetStableId(asset!.identity, "stool");
    };

    const firstId = await publishStool("Stool");
    const placement: AssetTransform = {
      position: [1, 2, 3],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    await writeSceneTransforms(storage, "demo", { [firstId]: placement });

    // 绕过 deleteAsset 的清理，直接换成同 slug 的新资产
    await storage.remove(assetDir("demo", "stool"));
    const secondId = await publishStool("Stool again");

    expect(secondId).not.toBe(firstId);
    const scene = (await getProjectState(storage, "demo")).scene;
    // 新资产在自己的键下没有任何记录（旧记录还在，只是它认领不到）
    expect(scene?.transforms[secondId]).toBeUndefined();
    expect(scene?.transforms[firstId]?.position).toEqual([1, 2, 3]);
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
      createExclusive: (path, content) => storage.createExclusive(path, content),
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
      createExclusive: (path, content) => storage.createExclusive(path, content),
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

describe("writeSceneLayout 材质", () => {
  test("只提交材质时不动摆放，只提交摆放时不动材质", async () => {
    await createProject(storage, { name: "材质", slug: "material-demo" });
    await writeSceneLayout(storage, "material-demo", {
      transforms: {
        chair: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      materials: {
        chair: { textures: { map: "projects/material-demo/source/1-ref.png" } },
      },
    });

    // 只提交摆放：材质必须留下（这正是把 materials 放成兄弟表而不是塞进 transform 的原因）
    await writeSceneTransforms(storage, "material-demo", {
      chair: { position: [4, 0, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    let scene = (await getProjectState(storage, "material-demo")).scene;
    expect(scene?.transforms.chair?.position).toEqual([4, 0, 4]);
    expect(scene?.materials.chair?.textures.map).toBe(
      "projects/material-demo/source/1-ref.png",
    );

    // 只提交材质：摆放必须留下
    await writeSceneLayout(storage, "material-demo", {
      materials: { table: { textures: { normalMap: "projects/material-demo/source/2-n.png" } } },
    });
    scene = (await getProjectState(storage, "material-demo")).scene;
    expect(scene?.transforms.chair?.position).toEqual([4, 0, 4]);
    expect(scene?.materials.chair?.textures.map).toBe(
      "projects/material-demo/source/1-ref.png",
    );
    expect(scene?.materials.table?.textures.normalMap).toBe(
      "projects/material-demo/source/2-n.png",
    );
  });

  test("旧 scene.json 没有 materials 键也能读，写回后补上空表", async () => {
    await createProject(storage, { name: "旧摆放", slug: "material-legacy" });
    // 旧版本写下的文件：只有 schemaVersion/transforms/updatedAt，没有 materials
    await storage.writeText(
      "projects/material-legacy/scene.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          transforms: {
            chair: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const readBack = (await getProjectState(storage, "material-legacy")).scene;
    // 旧文件按 slug 索引，读出来已经被改写成稳定 id；这个工程里没有真实资产，
    // 所以 id 退化成 slug 派生值（与 assetStableId 一致）
    expect(readBack?.transforms[sceneKey("chair")]?.position).toEqual([1, 2, 3]);
    expect(readBack?.materials).toEqual({});

    await writeSceneLayout(storage, "material-legacy", {
      materials: {
        [sceneKey("chair")]: {
          textures: { map: "projects/material-legacy/source/1-ref.png" },
        },
      },
    });
    const rewritten = JSON.parse(
      await storage.readText("projects/material-legacy/scene.json"),
    ) as { materials?: unknown; schemaVersion?: number };
    expect(rewritten.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(rewritten.materials).toEqual({
      [sceneKey("chair")]: {
        textures: { map: "projects/material-legacy/source/1-ref.png" },
      },
    });
  });

  test("材质里的 shader 档位已移除：旧文件残留的键读取时被丢掉，不报错", async () => {
    await createProject(storage, { name: "旧档位", slug: "material-shader-legacy" });
    // 曾经写过 shader 字段的旧文件；直接删值会让整个工程读不出来（校验失败抛 500），
    // 所以靠 zod 默认 strip 丢掉它，只保留贴图
    await storage.writeText(
      "projects/material-shader-legacy/scene.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          transforms: {},
          materials: {
            chair: { shader: "wireframe", textures: { map: "projects/material-shader-legacy/source/1-ref.png" } },
          },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const scene = (await getProjectState(storage, "material-shader-legacy")).scene;
    expect(scene?.materials[sceneKey("chair")]?.textures.map).toBe(
      "projects/material-shader-legacy/source/1-ref.png",
    );
    expect(scene?.materials[sceneKey("chair")]).not.toHaveProperty("shader");

    // 再写一次之后，文件里也不再残留 shader
    await writeSceneLayout(storage, "material-shader-legacy", { transforms: {} });
    const rewritten = JSON.parse(
      await storage.readText("projects/material-shader-legacy/scene.json"),
    ) as { materials?: Record<string, unknown> };
    expect(rewritten.materials?.[sceneKey("chair")]).not.toHaveProperty("shader");
  });

  test("删除资产时材质与摆放一起摘掉", async () => {
    await createProject(storage, { name: "删材质", slug: "material-delete" });
    await storage.writeBytes("projects/material-delete/assets/stool/0-stool.glb", PNG_BYTES);
    await writeSceneLayout(storage, "material-delete", {
      transforms: {
        [sceneKey("stool")]: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      materials: { [sceneKey("stool")]: { textures: {} } },
    });

    await deleteAsset(storage, "material-delete", "stool");
    const scene = (await getProjectState(storage, "material-delete")).scene;
    expect(scene?.transforms[sceneKey("stool")]).toBeUndefined();
    expect(scene?.materials[sceneKey("stool")]).toBeUndefined();
  });

  test("拒绝未知贴图通道与穿越路径", async () => {
    await createProject(storage, { name: "坏材质", slug: "material-bad" });
    await expect(
      writeSceneLayout(storage, "material-bad", {
        materials: {
          chair: { textures: { nope: "projects/material-bad/source/1-ref.png" } as never },
        },
      }),
    ).rejects.toThrow();
    await expect(
      writeSceneLayout(storage, "material-bad", {
        materials: {
          chair: { textures: { map: "../escape.png" } },
        },
      }),
    ).rejects.toThrow();
  });
});

describe("scene.json 版本与 revision", () => {
  test("旧 v1 文件读得出、写一次变 v2 且 revision 从 0 到 1", async () => {
    await createProject(storage, { name: "旧版摆放", slug: "scene-v1" });
    await storage.writeText(
      "projects/scene-v1/scene.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          transforms: {
            chair: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    // 读取：迁移到当前版本，旧内容改写到稳定 id 键下，revision 为 0（还没按新方案写过）
    const readBack = (await getProjectState(storage, "scene-v1")).scene;
    expect(readBack?.transforms[sceneKey("chair")]?.position).toEqual([1, 2, 3]);
    expect(readBack?.revision).toBe(0);

    const written = await writeSceneTransforms(storage, "scene-v1", {
      [sceneKey("chair")]: { position: [4, 5, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    expect(written.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(written.revision).toBe(1);

    const onDisk = JSON.parse(await storage.readText("projects/scene-v1/scene.json")) as {
      schemaVersion: number;
      revision: number;
      materials: Record<string, unknown>;
    };
    expect(onDisk.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(onDisk.revision).toBe(1);
    // 旧文件没有 materials，写回时补上
    expect(onDisk.materials).toEqual({});
  });

  test("每次写入 revision 自增", async () => {
    await createProject(storage, { name: "自增", slug: "scene-rev" });
    // 没有文档时第一次写入是 1
    expect((await writeSceneTransforms(storage, "scene-rev", {})).revision).toBe(1);
    expect((await writeSceneTransforms(storage, "scene-rev", {})).revision).toBe(2);
    // 材质与摆放共用一个文档，也共用同一个 revision 序列
    expect(
      (await writeSceneLayout(storage, "scene-rev", {
        materials: { [sceneKey("chair")]: { textures: {} } },
      })).revision,
    ).toBe(3);
    expect((await getProjectState(storage, "scene-rev")).scene?.revision).toBe(3);
  });

  test("删除资产摘掉条目时也递增 revision", async () => {
    await createProject(storage, { name: "删条目", slug: "scene-drop" });
    await storage.writeBytes("projects/scene-drop/assets/stool/0-stool.glb", PNG_BYTES);
    const written = await writeSceneTransforms(storage, "scene-drop", {
      [sceneKey("stool")]: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    expect(written.revision).toBe(1);

    await deleteAsset(storage, "scene-drop", "stool");
    const scene = (await getProjectState(storage, "scene-drop")).scene;
    expect(scene?.transforms[sceneKey("stool")]).toBeUndefined();
    expect(scene?.revision).toBe(2);
  });

  test("版本高于当前时读取报带路径的错", async () => {
    await createProject(storage, { name: "太新", slug: "scene-future" });
    await storage.writeText(
      "projects/scene-future/scene.json",
      JSON.stringify({
        schemaVersion: SCENE_SCHEMA_VERSION + 1,
        transforms: {},
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await expect(getProjectState(storage, "scene-future")).rejects.toThrow(/scene-future/);
    await expect(getProjectState(storage, "scene-future")).rejects.toThrow(/高于当前支持的/);
  });
});
