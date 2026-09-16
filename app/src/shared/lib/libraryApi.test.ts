import { describe, expect, test } from "bun:test";
import { deriveLibraryAssets, type ProjectState } from "./libraryApi";

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
});
