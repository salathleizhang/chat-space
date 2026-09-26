import { describe, expect, test } from "bun:test";
import {
  deriveLibraryAssets,
  selectProjectSkybox,
  type ProjectState,
} from "./libraryApi";

function state(files: string[], latestModelOperation?: string): ProjectState {
  return {
    project: {
      slug: "demo",
      name: "Demo",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    sources: [],
    generatedReferences: [],
    hasAnalysis: false,
    assets: [{ slug: "chair", files, latestModelOperation }],
  };
}

describe("deriveLibraryAssets 模型代次语义", () => {
  test("普通任务同代多格式只渲染优选主文件", () => {
    const [asset] = deriveLibraryAssets(
      "demo",
      state(["0-chair.glb", "0-chair.fbx"], "animations"),
    );
    expect(asset).toBeDefined();
    expect(asset?.modelPath).toEndWith("0-chair.glb");
    expect(asset!.modelPaths).toEqual([asset!.modelPath!]);
  });

  test("Tripo 分段同代多文件作为一个完整装配渲染", () => {
    const [asset] = deriveLibraryAssets(
      "demo",
      state(["1-chair.glb", "1-chair-f2.glb"], "v3/mesh/segment"),
    );
    expect(asset?.modelPaths.map((path) => path.split("/").pop())).toEqual([
      "1-chair.glb",
      "1-chair-f2.glb",
    ]);
  });

  test("天空盒编辑后的 LDR 全景图按索引覆盖旧 HDR", () => {
    const projectState = state([
      "0-evening-sky.png",
      "1-evening-sky.hdr",
      "2-evening-sky.png",
    ]);
    projectState.assets[0]!.slug = "evening-sky";
    projectState.assets[0]!.identity = {
      kind: "skybox",
      name: "Evening sky",
      intent: "purple aurora",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceImages: [],
    };

    const [asset] = deriveLibraryAssets("demo", projectState);
    expect(asset?.hdrPath).toEndWith("2-evening-sky.png");
  });

  test("天空盒单例选择：当前指针优先，无指针时使用最近创建的一项", () => {
    const base = deriveLibraryAssets("demo", {
      ...state([]),
      assets: [
        {
          slug: "old-sky",
          files: ["0-old-sky.hdr"],
          identity: {
            kind: "skybox",
            name: "Old",
            intent: "old",
            sourceImages: [],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          slug: "new-sky",
          files: ["0-new-sky.png"],
          identity: {
            kind: "skybox",
            name: "New",
            intent: "new",
            sourceImages: [],
            createdAt: "2026-02-01T00:00:00.000Z",
          },
        },
      ],
    });

    expect(selectProjectSkybox(base)?.assetSlug).toBe("new-sky");
    expect(selectProjectSkybox(base, "old-sky")?.assetSlug).toBe("old-sky");
  });
});
