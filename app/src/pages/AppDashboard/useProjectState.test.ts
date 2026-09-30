import { beforeEach, describe, expect, mock, test } from "bun:test";
import { flush, renderHook } from "../../test-utils";
import type { LibraryAsset, ProjectState } from "../../shared/lib/libraryApi";

/**
 * 回归：**新物件落盘后，已有物件不该换 loader 身份。**
 *
 * 界面上看到的是"每生成一件新家具，场景里所有模型都重新加载一遍"；根因是这里曾经把
 * 工作台的全局 `refreshKey` 当资源代次发给每个资产，而 `refreshKey` 在**每个**后台任务
 * 落盘时都会 +1（useTaskPolling 的完成回调），于是每落盘一件就把前面所有件重新下载解析。
 * 现在改成按资产发放（shared/lib/resourceRevisions.ts），这个测试钉住它。
 */

/** 每次扫描按顺序兑现一个快照：像真实链路一样，一次 refreshKey 换一次 fetchProjectState */
let scans: (ProjectState | null)[] = [];
const fetchProjectState = mock(
  async (_slug: string): Promise<ProjectState | null> => scans.shift() ?? null,
);
const actualLibraryApi = await import("../../shared/lib/libraryApi");
mock.module("../../shared/lib/libraryApi", () => ({ ...actualLibraryApi, fetchProjectState }));
// hook 只用到导航重定向；测试台没有 Router 上下文，给一个 no-op。
// **必须是稳定引用**：真实的 useNavigate 返回的函数身份稳定，若每次渲染都换一个新函数，
// effect 依赖就每次都变、每渲染多跑一次扫描，测试也就测不到"一次 refreshKey 一次扫描"。
const navigate = () => {};
mock.module("react-router-dom", () => ({ useNavigate: () => navigate }));

const { useProjectState } = await import("./useProjectState");

function asset(slug: string, id: string, files: string[]) {
  return {
    slug,
    identity: {
      id,
      kind: "model" as const,
      name: slug,
      intent: slug,
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceImages: [],
    },
    files,
    nextIndex: 1,
  };
}

function projectState(assets: ReturnType<typeof asset>[]): ProjectState {
  return {
    project: {
      slug: "p",
      name: "P",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    sources: [],
    generatedReferences: [],
    hasAnalysis: false,
    assets,
  };
}

const bySlug = (assets: LibraryAsset[], slug: string) =>
  assets.find((a) => a.assetSlug === slug)!;

beforeEach(() => {
  scans = [];
});

describe("useProjectState 的资源修订号", () => {
  test("新资产落盘只给它自己发新号，已有资产的号不动", async () => {
    const chair = asset("chair", "uuid-chair", ["0-chair.glb"]);
    const table = asset("table", "uuid-table", ["0-table.glb"]);
    scans = [projectState([chair]), projectState([chair, table])];

    const h = await renderHook(
      ({ key }: { key: number }) => useProjectState("p", key),
      { key: 0 },
    );
    await flush();
    const before = bySlug(h.result.current.assets, "chair").resourceRevision;
    expect(before).toBeDefined();

    // 第二件落盘 → refreshKey +1（useTaskPolling 就是这么干的）
    await h.rerender({ key: 1 });
    await flush();
    const after = h.result.current.assets;
    expect(bySlug(after, "chair").resourceRevision).toBe(before);
    expect(bySlug(after, "table").resourceRevision).not.toBe(before);
    await h.unmount();
  });

  test("同一资产换代（新索引文件）才换号", async () => {
    scans = [
      projectState([asset("chair", "uuid-chair", ["0-chair.glb"])]),
      projectState([asset("chair", "uuid-chair", ["1-chair.glb"])]),
    ];

    const h = await renderHook(
      ({ key }: { key: number }) => useProjectState("p", key),
      { key: 0 },
    );
    await flush();
    const before = bySlug(h.result.current.assets, "chair").resourceRevision;

    await h.rerender({ key: 1 });
    await flush();
    expect(bySlug(h.result.current.assets, "chair").resourceRevision).not.toBe(before);
    await h.unmount();
  });

  test("缩略图/自检图落盘（隐藏产物与目录项）不换号", async () => {
    const base = ["0-chair.glb"];
    scans = [
      projectState([asset("chair", "uuid-chair", base)]),
      projectState([asset("chair", "uuid-chair", [...base, ".thumb-0-chair.png", "inspections"])]),
    ];

    const h = await renderHook(
      ({ key }: { key: number }) => useProjectState("p", key),
      { key: 0 },
    );
    await flush();
    const before = bySlug(h.result.current.assets, "chair").resourceRevision;

    await h.rerender({ key: 1 });
    await flush();
    expect(bySlug(h.result.current.assets, "chair").resourceRevision).toBe(before);
    await h.unmount();
  });

  test("同名重建（slug 复用）拿的是新号，不复用旧资产的缓存", async () => {
    scans = [
      projectState([asset("chair", "uuid-old", ["0-chair.glb"])]),
      projectState([asset("chair", "uuid-new", ["0-chair.glb"])]),
    ];

    const h = await renderHook(
      ({ key }: { key: number }) => useProjectState("p", key),
      { key: 0 },
    );
    await flush();
    const before = bySlug(h.result.current.assets, "chair").resourceRevision;

    await h.rerender({ key: 1 });
    await flush();
    expect(bySlug(h.result.current.assets, "chair").resourceRevision).not.toBe(before);
    await h.unmount();
  });
});
