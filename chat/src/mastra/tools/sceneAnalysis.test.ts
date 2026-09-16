import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { assetDir, assetIdentityFile } from "../../common/libraryPaths";
import { AssetIdentitySchema } from "../../dto/library";
import {
  LocalFileStorage,
  setAssetStorage,
  writeJson,
} from "../../services/assetStorage";
import {
  setCurrentSceneAnalyzer,
  type CurrentSceneSnapshot,
} from "../../services/sceneAnalysis";
import {
  createProject,
  thumbnailFileName,
  writeSceneTransforms,
} from "./projectTools";
import { runAnalyzeCurrentScene } from "./sceneAnalysis";

const root = await mkdtemp(join(tmpdir(), "gabo-scene-analysis-test-"));
const storage = new LocalFileStorage(root);
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function buildTriangleGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position);
  const mesh = document.createMesh().addPrimitive(primitive);
  document.createScene().addChild(document.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(document);
}

async function addModelAsset(
  projectSlug: string,
  slug: string,
  name: string,
  createdAt: string,
): Promise<void> {
  const dir = assetDir(projectSlug, slug);
  const modelFile = `0-${slug}.glb`;
  await storage.writeBytes(`${dir}/${modelFile}`, await buildTriangleGlb());
  await storage.writeBytes(`${dir}/${thumbnailFileName(modelFile)}`, PNG_BYTES);
  await writeJson(storage, assetIdentityFile(projectSlug, slug), AssetIdentitySchema, {
    schemaVersion: 1,
    slug,
    kind: "model",
    name,
    intent: name,
    sourceImages: [],
    createdAt,
  });
}

let captured: CurrentSceneSnapshot | undefined;

beforeAll(async () => {
  setAssetStorage(storage);
  setCurrentSceneAnalyzer(async ({ snapshot }) => {
    captured = snapshot;
    return {
      overview: "桌椅场景",
      assets: snapshot.assets.map((asset) => ({
        slug: asset.slug,
        visualSummary: asset.name,
        spatialRole: "场景道具",
      })),
      relationships: ["椅子位于桌子右侧"],
      issues: [],
      suggestions: [],
    };
  });

  await createProject(storage, { name: "Layout", slug: "layout" });
  await addModelAsset("layout", "chair", "椅子", "2026-01-01T00:00:00.000Z");
  await addModelAsset("layout", "table", "桌子", "2026-01-02T00:00:00.000Z");
  await writeSceneTransforms(storage, "layout", {
    chair: {
      position: [10, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  await createProject(storage, { name: "Empty", slug: "empty-scene" });
});

afterAll(async () => {
  setAssetStorage(undefined);
  setCurrentSceneAnalyzer(undefined);
  await rm(root, { recursive: true, force: true });
});

describe("analyze-scene", () => {
  test("把缩略图、有效 Transform 与 GLB 世界包围盒交给场景分析器", async () => {
    const result = await runAnalyzeCurrentScene(
      "layout",
      {},
      { apiKey: "sk-test" },
    );

    expect(result.assetCount).toBe(2);
    expect(result.thumbnailsProvided).toBe(2);
    expect(result.boundsProvided).toBe(2);
    expect(captured?.assets.map((asset) => asset.slug)).toEqual(["chair", "table"]);
    expect(captured?.assets[0]?.transform.position).toEqual([10, 0, 0]);
    // 未手动摆放的桌子使用与 app 视口一致的两列默认网格位置。
    expect(captured?.assets[1]?.transform.position).toEqual([1.5, 0, 0]);
    expect(captured?.assets[0]?.bounds).toEqual({
      min: [10, 0, 0],
      max: [11, 1, 0],
      size: [1, 1, 0],
    });
    expect(captured?.assets[0]?.thumbnailDataUri).toStartWith(
      "data:image/png;base64,",
    );
  });

  test("当前场景没有模型时明确拒绝", () => {
    expect(
      runAnalyzeCurrentScene("empty-scene", {}, { apiKey: "sk-test" }),
    ).rejects.toThrow("没有可分析的模型资产");
  });
});
