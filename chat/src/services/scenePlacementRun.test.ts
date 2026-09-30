import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Document, NodeIO, Primitive } from "@gltf-transform/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetDir,
  assetIdentityFile,
  projectAnalysisFile,
  projectSourceDir,
} from "../common/libraryPaths";
import {
  AssetIdentitySchema,
  SceneAnalysisSchema,
  createAssetIdentity,
} from "../dto/library";
import { createProject, getProjectState, setCurrentWorld } from "../mastra/tools/projectTools";
import { LocalFileStorage, writeJson } from "./assetStorage";
import { ensureSceneSpecFromAnalysis } from "./sceneJobs";
import { runScenePlacement } from "./scenePlacementRun";

/**
 * 摆放的端到端测试：真实的 GLB（用 @gltf-transform 现场写）、真实的 analysis.json、
 * 真实的世界 collider 地形。断言的是"用户最终看到的东西"——scene.json 里按稳定 id
 * 索引的 transforms。
 */

const root = await mkdtemp(join(tmpdir(), "chatspace-placement-test-"));
const storage = new LocalFileStorage(root);
const projectSlug = "placement-e2e";
const sourceImage = `${projectSourceDir(projectSlug)}/0-room.png`;

/** 1200×800 = 宽高比 1.5 的 PNG 头（摆放只读头部拿比例）。 */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** 一个轴对齐长方体的 GLB；模型与 collider 地形共用这个构造器。 */
async function boxGlb(
  min: [number, number, number],
  max: [number, number, number],
): Promise<Uint8Array> {
  const corners: number[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) corners.push(x, y, z);
    }
  }
  // 顶点顺序：xyz 按 (x,y,z) 三重循环，索引 0..7
  const quads = [
    [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1],
    [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3],
  ];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a!, b!, c!, a!, c!, d!);

  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor("POSITION")
    .setType("VEC3")
    .setArray(new Float32Array(corners))
    .setBuffer(buffer);
  const index = document
    .createAccessor("indices")
    .setType("SCALAR")
    .setArray(new Uint16Array(indices))
    .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setIndices(index)
    .setMode(Primitive.Mode.TRIANGLES ?? 4);
  const mesh = document.createMesh("mesh").addPrimitive(primitive);
  document.createScene("scene").addChild(document.createNode("node").setMesh(mesh));
  return new NodeIO().writeBinary(document);
}

async function createModelAsset(slug: string, name: string, glb: Uint8Array) {
  const identity = createAssetIdentity({
    slug,
    kind: "model",
    name,
    intent: `${name} 测试模型`,
    sourceImages: [sourceImage],
  });
  await writeJson(storage, assetIdentityFile(projectSlug, slug), AssetIdentitySchema, identity);
  await storage.writeBytes(`${assetDir(projectSlug, slug)}/0-${slug}.glb`, glb);
  return identity;
}

const CAMERA = { horizonRow: 0.5, cameraHeightMeters: 1.5, verticalFovDeg: 60 };
const SOFA_BOX = [0.45, 0.6, 0.55, 0.9] as [number, number, number, number];
/** 沙发资产的**稳定 id**：scene.json 的 transforms 就按它索引。 */
let sofaId = "";

const focalLength = (): number => 0.5 / Math.tan((60 * Math.PI) / 360);

beforeAll(async () => {
  await createProject(storage, { name: "摆放 E2E", slug: projectSlug });
  await storage.writeBytes(sourceImage, pngHeader(1200, 800));
  await writeJson(storage, projectAnalysisFile(projectSlug), SceneAnalysisSchema, {
    schemaVersion: 1,
    confirmation: {
      runId: "22222222-2222-4222-8222-222222222222",
      selectedSlugs: ["sofa", "lamp"],
      allSelected: false,
    },
    sceneName: "客厅",
    sceneDescription: "木地板客厅",
    environment: { lighting: "daylight" },
    objects: [
      { slug: "sofa", name: "沙发", description: "灰色布艺沙发", box: SOFA_BOX, sourceImages: [sourceImage] },
      // 没有 box：旧分析或 revise 新增的对象，摆放要跳过并如实报告。
      { slug: "lamp", name: "落地灯", description: "细杆落地灯", sourceImages: [sourceImage] },
      // 有 box 但没有模型资产：也要如实报告。
      { slug: "ghost", name: "幽灵椅", description: "还没生成的椅子", box: [0.1, 0.1, 0.2, 0.4], sourceImages: [sourceImage] },
    ],
    sources: [sourceImage],
    camera: CAMERA,
    analyzedAt: new Date().toISOString(),
  });
  sofaId = (await createModelAsset("sofa", "沙发", await boxGlb([0, 0, 0], [2, 1, 1]))).id!;
  await createModelAsset("lamp", "落地灯", await boxGlb([0, 0, 0], [0.4, 1.8, 0.4]));

  // 世界 collider：20×20 的楼板，抬高到 y=0.35，用来验证"脚底贴真实地面"。
  const worldIdentity = createAssetIdentity({
    slug: "world",
    kind: "world",
    name: "world",
    intent: "空环境世界",
    sourceImages: [sourceImage],
  });
  await writeJson(storage, assetIdentityFile(projectSlug, "world"), AssetIdentitySchema, worldIdentity);
  await storage.writeText(
    `${assetDir(projectSlug, "world")}/0-world.json`,
    JSON.stringify({
      assets: {
        splats: {
          semantics_metadata: {
            flip_y: false,
            metric_scale_factor: 1,
            ground_plane_offset: 0,
          },
        },
      },
    }),
  );
  await storage.writeBytes(
    `${assetDir(projectSlug, "world")}/0-world.glb`,
    await boxGlb([-10, 0.35, -10], [10, 0.5, 10]),
  );
  await setCurrentWorld(storage, projectSlug, "world");
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("runScenePlacement 端到端", () => {
  test("按参考图摆放有框有模型的对象，写进 scene.json 的 transforms", async () => {
    await ensureSceneSpecFromAnalysis(storage, projectSlug);
    const report = await runScenePlacement(storage, projectSlug);

    expect(report.placed.map((object) => object.slug)).toEqual(["sofa"]);
    expect(report.ground).toBe("collider");
    expect(report.aspect).toBeCloseTo(1.5, 6);
    expect(report.camera).toEqual(CAMERA);

    const sofa = report.placed[0]!;
    // 框是画面中央 → x = 0；接地行 0.9、地平线 0.5、相机高 1.5、fov 60 → 纵深 3.2476。
    const focal = 0.5 / Math.tan((60 * Math.PI) / 360);
    expect(sofa.position[0]).toBeCloseTo(0, 6);
    expect(sofa.position[2]).toBeCloseTo(-((1.5 * focal) / 0.4), 6);
    // 世界的 collider 地形在 y=0.35，模型自身最低点是 0 → 脚底落在 0.35。
    expect(sofa.grounded).toBe(true);
    expect(sofa.position[1]).toBeCloseTo(0.35, 6);

    // 场景文件按**稳定 id** 索引，和 gizmo 手动摆放同一张表。
    const state = await getProjectState(storage, projectSlug);
    const stored = state.scene?.transforms[sofaId];
    expect(stored?.position[0]).toBeCloseTo(sofa.position[0], 6);
    expect(stored?.position[1]).toBeCloseTo(sofa.position[1], 6);
    expect(stored?.position[2]).toBeCloseTo(sofa.position[2], 6);

    // 没框、没模型的对象都要如实报告原因，而不是静默留在网格位上。
    expect(report.skipped).toEqual([
      { slug: "lamp", name: "落地灯", reason: "no_box" },
      { slug: "ghost", name: "幽灵椅", reason: "no_model" },
    ]);
  });

  test("items 补框后能摆上没有框的对象；未知 slug 会被指出来", async () => {
    const report = await runScenePlacement(storage, projectSlug, {
      items: [
        { slug: "lamp", box: [0.7, 0.55, 0.8, 0.95], heightMeters: 1.8 },
        { slug: "nobody", box: [0.1, 0.1, 0.2, 0.2] },
      ],
    });
    expect(report.placed.map((object) => object.slug)).toEqual(["sofa", "lamp"]);
    const lamp = report.placed.find((object) => object.slug === "lamp")!;
    // 量到 1.8（Float32 存储，会有极小误差）、目标 1.8 → 缩放约 1；框在画面右侧，x 必须为正。
    expect(lamp.scale[0]).toBeCloseTo(1, 5);
    expect(lamp.position[0]).toBeGreaterThan(0);
    expect(report.skipped).toContainEqual({
      slug: "nobody",
      name: "nobody",
      reason: "unknown_slug",
    });
    // 显式覆盖的相机估计优先于规格里的。
    const moved = await runScenePlacement(storage, projectSlug, {
      camera: { ...CAMERA, cameraHeightMeters: 3 },
    });
    expect(moved.camera.cameraHeightMeters).toBe(3);
    expect(moved.placed[0]!.position[2]).toBeCloseTo(
      -((3 * focalLength()) / 0.4),
      6,
    );
  });
});
