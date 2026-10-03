import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { ChatServiceError } from "../common/errors";
import { assetDir, assetIdentityFile, projectSceneFile } from "../common/libraryPaths";
import type { AssetKind, Vec3 } from "../dto/library";
import { AssetIdentitySchema } from "../dto/library";
import {
  LocalFileStorage,
  setAssetStorage,
  writeJson,
} from "../services/assetStorage";
import { buildRequestContext } from "../services/workflowRuns";
import { createProject, writeSceneTransforms } from "../mastra/tools/projectTools";
import { placeObjectTool } from "../mastra/tools/placeObject";
import { placeObjects } from "./objectPlacement";

const root = await mkdtemp(join(tmpdir(), "chatspace-object-placement-test-"));
const storage = new LocalFileStorage(root);
const SLUG = "place-demo";
const EMPTY_SLUG = "place-empty";

/** 用真实 GLB 字节做夹具：摆放要量包围盒、要把摆放烘进顶点，假字节过不了这一关。 */
async function glbFromTriangles(
  triangles: readonly (readonly [Vec3, Vec3, Vec3])[],
): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = new Float32Array(triangles.length * 9);
  triangles.forEach((triangle, index) => {
    triangle.forEach((point, corner) => {
      positions.set(point, index * 9 + corner * 3);
    });
  });
  const accessor = document
    .createAccessor()
    .setType("VEC3")
    .setArray(positions)
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", accessor);
  const mesh = document.createMesh().addPrimitive(primitive);
  document.createScene().addChild(document.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(document);
}

/** 水平正方形（两个三角形），用来当"桌面/坐垫"。 */
function slab(y: number, x0: number, z0: number, x1: number, z1: number) {
  return [
    [[x0, y, z0], [x1, y, z0], [x1, y, z1]] as [Vec3, Vec3, Vec3],
    [[x0, y, z0], [x1, y, z1], [x0, y, z1]] as [Vec3, Vec3, Vec3],
  ];
}

/** 长方体（12 个三角形）。 */
function box(min: Vec3, max: Vec3): [Vec3, Vec3, Vec3][] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: Vec3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  return [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7],
    [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2],
  ].map(([a, b, c]) => [v[a!]!, v[b!]!, v[c!]!]);
}

async function addAsset(
  projectSlug: string,
  slug: string,
  id: string,
  createdAt: string,
  model: Uint8Array | null,
  kind: AssetKind = "model",
): Promise<void> {
  const dir = assetDir(projectSlug, slug);
  if (model) {
    await storage.writeBytes(`${dir}/0-${slug}.glb`, model);
  }
  await writeJson(storage, assetIdentityFile(projectSlug, slug), AssetIdentitySchema, {
    schemaVersion: 1,
    id,
    slug,
    kind,
    name: slug,
    intent: slug,
    sourceImages: [],
    createdAt,
  });
}

beforeAll(async () => {
  setAssetStorage(storage);
  await createProject(storage, { name: "Place", slug: SLUG });
  await addAsset(
    SLUG,
    "table",
    "asset-table",
    "2026-01-01T00:00:00.000Z",
    await glbFromTriangles(slab(1, -1, -1, 1, 1)),
  );
  // 长方体 [0,0,0]→[1,2,1]：包围盒底心 (0.5, 0, 0.5)，高 2——用来验证"底面中心"语义。
  await addAsset(
    SLUG,
    "doll",
    "asset-doll",
    "2026-01-01T00:00:01.000Z",
    await glbFromTriangles(box([0, 0, 0], [1, 2, 1])),
  );
  await addAsset(SLUG, "no-model", "asset-no-model", "2026-01-01T00:00:02.000Z", null, "other");
  // 竖直墙面：XZ 投影退化成一条线，包围盒中心正上方取不到任何水平面。
  await addAsset(
    SLUG,
    "wall",
    "asset-wall",
    "2026-01-01T00:00:03.000Z",
    await glbFromTriangles([[[0, 0, -1], [0, 2, -1], [0, 2, 1]] as [Vec3, Vec3, Vec3]]),
  );
  // world 是场景背景，不参与摆放：给它写记录只会是"成功但永不被应用"的静默空操作。
  await addAsset(SLUG, "world", "asset-world", "2026-01-01T00:00:04.000Z", null, "world");

  await createProject(storage, { name: "PlaceEmpty", slug: EMPTY_SLUG });
  await addAsset(
    EMPTY_SLUG,
    "solo",
    "asset-solo",
    "2026-01-01T00:00:00.000Z",
    await glbFromTriangles(box([0, 0, 0], [1, 2, 1])),
  );
});

afterAll(async () => {
  setAssetStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

describe("placeObjects：显式位置", () => {
  test("position 的语义是包围盒底面中心，heightMeters 按真实高度归一", async () => {
    const report = await placeObjects(storage, SLUG, [
      { slug: "doll", position: [4, 1, -2], heightMeters: 0.5 },
    ]);

    // 高 2 的模型缩到 0.5 → scale 0.25；底心局部坐标 (0.5, 0, 0.5) → 原点要往回扣。
    expect(report.placed).toHaveLength(1);
    const placed = report.placed[0]!;
    expect(placed.scale).toEqual([0.25, 0.25, 0.25]);
    expect(placed.position[0]).toBeCloseTo(3.875, 9);
    expect(placed.position[1]).toBeCloseTo(1, 9);
    expect(placed.position[2]).toBeCloseTo(-2.125, 9);
    expect(placed.bottomCenter).toEqual([4, 1, -2]);
    expect(placed.bounds.min[1]).toBeCloseTo(1, 9);
    expect(placed.bounds.size[1]).toBeCloseTo(0.5, 9);
    expect(report.skipped).toEqual([]);
  });

  test("写进 scene.json 的键是资产稳定 id，不是 slug", async () => {
    const report = await placeObjects(storage, SLUG, [
      { slug: "doll", position: [0, 0, 0], scale: 1 },
    ]);
    const scene = (await readJsonRaw()) as {
      transforms: Record<string, unknown>;
    };
    expect(Object.keys(scene.transforms)).toContain("asset-doll");
    expect(Object.keys(scene.transforms)).not.toContain("doll");
    expect(scene.transforms["asset-doll"]).toEqual({
      position: report.placed[0]!.position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
  });

  test("yawDegrees 只绕 +Y 转，rotation 与它互斥", async () => {
    const report = await placeObjects(storage, SLUG, [
      { slug: "doll", position: [0, 0, 0], yawDegrees: 90 },
    ]);
    expect(report.placed[0]!.rotation[1]).toBeCloseTo(Math.PI / 2, 9);

    await expect(
      placeObjects(storage, SLUG, [
        { slug: "doll", position: [0, 0, 0], rotation: [0, 1, 0], yawDegrees: 45 },
      ]),
    ).rejects.toThrow("rotation 与 yawDegrees 只能给一个");
  });
});

describe("placeObjects：落到目标资产的上表面", () => {
  test("按目标的**当前摆放**取表面：目标被移动/放大后落点跟着走", async () => {
    // 桌面局部在 y=1；摆到 (5,2,−3) 并放大 2 倍 → 世界台面 y = 2 + 2×1 = 4。
    await writeSceneTransforms(storage, SLUG, {
      "asset-table": {
        position: [5, 2, -3],
        rotation: [0, 0, 0],
        scale: [2, 2, 2],
      },
    });

    const report = await placeObjects(storage, SLUG, [
      { slug: "doll", onSurfaceOf: { slug: "table" }, heightMeters: 0.5 },
    ]);

    const placed = report.placed[0]!;
    expect(placed.surface).toEqual({
      targetSlug: "table",
      point: [5, 4, -3],
      surfaceY: 4,
    });
    expect(placed.bottomCenter[1]).toBeCloseTo(4, 9);
    expect(placed.bounds.min[1]).toBeCloseTo(4, 9);
    // 采样点取目标的包围盒中心：x=5±2、z=−3±2
    expect(placed.bottomCenter[0]).toBeCloseTo(5, 9);
    expect(placed.bottomCenter[2]).toBeCloseTo(-3, 9);
  });

  test("只动点名的对象：目标自己的摆放原样保留", async () => {
    const scene = (await readJsonRaw()) as { transforms: Record<string, unknown> };
    expect(scene.transforms["asset-table"]).toEqual({
      position: [5, 2, -3],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    });
  });

  test("offset 把采样点挪到表面之外时明确报 no_surface，而不是蒙一个高度", async () => {
    const report = await placeObjects(storage, SLUG, [
      {
        slug: "doll",
        onSurfaceOf: { slug: "table", offset: [100, 0, 100] },
      },
    ]);
    expect(report.placed).toEqual([]);
    expect(report.skipped).toEqual([
      { slug: "doll", name: "doll", reason: "no_surface" },
    ]);
  });

  test("同一次调用里先摆目标、再落上去：用得到前一步刚写的结果", async () => {
    const report = await placeObjects(storage, SLUG, [
      // 桌面局部 y=1、缩放 3 → 底心落点 (1,0,1) 之后，台面世界高度 = 0。
      { slug: "table", position: [1, 0, 1], scale: 3 },
      { slug: "doll", onSurfaceOf: { slug: "table" }, heightMeters: 0.5 },
    ]);

    expect(report.placed).toHaveLength(2);
    const table = report.placed[0]!;
    // 目标自己的落点：底面中心 (0,1,0)×3 从原点扣掉 → 原点 y = 0 − 3 = −3，台面回到 0。
    expect(table.position[1]).toBeCloseTo(-3, 9);
    const doll = report.placed[1]!;
    expect(doll.surface?.surfaceY).toBeCloseTo(0, 9);
    expect(doll.bottomCenter[0]).toBeCloseTo(1, 9);
    expect(doll.bottomCenter[2]).toBeCloseTo(1, 9);
    expect(doll.bounds.min[1]).toBeCloseTo(0, 9);
  });
});

describe("placeObjects：跳过与拒绝", () => {
  test("逐个给出跳过原因，不认识的 slug、缺模型、目标不存在都如实列出", async () => {
    const report = await placeObjects(storage, SLUG, [
      { slug: "nope", position: [0, 0, 0] },
      { slug: "world", position: [0, 0, 0] },
      { slug: "no-model", position: [0, 0, 0] },
      { slug: "table", onSurfaceOf: { slug: "nope" } },
      { slug: "table", onSurfaceOf: { slug: "no-model" } },
      { slug: "table", onSurfaceOf: { slug: "wall" } },
    ]);
    expect(report.skipped.map((entry) => entry.reason)).toEqual([
      "unknown_slug",
      "world_asset",
      "no_model",
      "surface_target_missing",
      "surface_target_no_model",
      "no_surface",
    ]);
  });

  test("互斥参数明确报错，不做静默取舍", async () => {
    const cases: [Parameters<typeof placeObjects>[2][number], string][] = [
      [
        { slug: "doll", position: [0, 0, 0], onSurfaceOf: { slug: "table" } },
        "position 与 onSurfaceOf 只能给一个",
      ],
      [{ slug: "doll" }, "必须给 position 或 onSurfaceOf"],
      [
        { slug: "doll", position: [0, 0, 0], heightMeters: 1, scale: 2 },
        "heightMeters 与 scale 只能给一个",
      ],
    ];
    for (const [item, message] of cases) {
      const error = await placeObjects(storage, SLUG, [item]).catch((thrown) => thrown);
      expect(error).toBeInstanceOf(ChatServiceError);
      expect((error as ChatServiceError).message).toContain(message);
      expect((error as ChatServiceError).code).toBe("invalid_placement_item");
    }
  });

  test("一个都没摆成时不写 scene.json（不改动已有记录）", async () => {
    const before = await readJsonRaw();
    const report = await placeObjects(storage, EMPTY_SLUG, [
      { slug: "ghost", position: [0, 0, 0] },
    ]);
    expect(report.placed).toEqual([]);
    expect(await storage.exists(projectSceneFile(EMPTY_SLUG))).toBe(false);
    expect(await readJsonRaw()).toEqual(before);
  });
});

describe("place-object 工具入口", () => {
  test("工具把入参交给同一实现，并按要求写盘", async () => {
    const result = (await placeObjectTool.execute!(
      { items: [{ slug: "doll", position: [2, 0.25, 2], heightMeters: 1 }] },
      { requestContext: buildRequestContext({ projectSlug: SLUG }) } as never,
    )) as Awaited<ReturnType<typeof placeObjects>>;
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0]!.bottomCenter).toEqual([2, 0.25, 2]);
    expect(result.scenePath).toBe(projectSceneFile(SLUG));
  });

  test("没有项目上下文时明确拒绝", () => {
    expect(
      placeObjectTool.execute!({ items: [{ slug: "doll", position: [0, 0, 0] }] }, {} as never),
    ).rejects.toThrow("当前请求没有有效的项目上下文");
  });
});

/** 直接读磁盘上的 scene.json 原文，验证"写进去就是这张表"。 */
async function readJsonRaw(): Promise<unknown> {
  const path = projectSceneFile(SLUG);
  if (!(await storage.exists(path))) return null;
  return JSON.parse(await storage.readText(path));
}
