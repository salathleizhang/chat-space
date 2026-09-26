import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORLD_SEMANTICS,
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

describe("deriveLibraryAssets world 语义", () => {
  const WORLD_FILES = [
    "0-world-100k.spz",
    "0-world-150k.spz",
    "0-world-500k.spz",
    "0-world-full_res.spz",
    "0-world-pano.png",
    "0-world.glb",
    "0-world.json",
  ];

  function worldState(files = WORLD_FILES, semantics?: ProjectState["assets"][number]["worldSemantics"]) {
    const projectState = state(files);
    projectState.assets[0]!.slug = "world";
    projectState.assets[0]!.identity = {
      kind: "world",
      name: "Meadow",
      intent: "rolling grassland",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceImages: [],
    };
    if (semantics) projectState.assets[0]!.worldSemantics = semantics;
    return projectState;
  }

  /**
   * 四档泼溅同名同索引，选错只会静默掉画质（100k 也能渲，只是糊），
   * 所以这条不变量必须有测试钉住。
   */
  test("同索引多档 spz 时选 full_res，而不是字典序碰巧的最后/最前一个", () => {
    const [asset] = deriveLibraryAssets("demo", worldState());
    expect(asset?.spzPath).toEndWith("0-world-full_res.spz");
  });

  test("world 资产的 spz 选择与文件列举顺序无关", () => {
    const reversed = [...WORLD_FILES].reverse();
    const [asset] = deriveLibraryAssets("demo", worldState(reversed));
    expect(asset?.spzPath).toEndWith("0-world-full_res.spz");
  });

  test("world 带上对齐参数；非 world 资产为 null", () => {
    const semantics = { flipY: true, metricScaleFactor: 2.6222534, groundPlaneOffset: 1.5924374 };
    const [world] = deriveLibraryAssets("demo", worldState(WORLD_FILES, semantics));
    expect(world?.worldSemantics).toEqual(semantics);

    const [chair] = deriveLibraryAssets("demo", state(["0-chair.glb"]));
    expect(chair?.worldSemantics).toBeNull();
  });

  /** 旧状态没有这个字段：必须退回「翻转」缺省，否则世界又是倒的 */
  test("world 缺语义字段时退回缺省（flipY 为 true）", () => {
    const [asset] = deriveLibraryAssets("demo", worldState());
    expect(asset?.worldSemantics).toEqual(DEFAULT_WORLD_SEMANTICS);
    expect(asset?.worldSemantics?.flipY).toBe(true);
  });
});
