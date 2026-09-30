import { describe, expect, test } from "bun:test";
import { createResourceRevisions, resourceSignature } from "./resourceRevisions";
import type { AssetResourceIdentity } from "./libraryApi";

/**
 * 回归：loader 身份必须按资产发号。
 *
 * 曾经的写法是把工作台的全局 `refreshKey` 塞给所有资产，而它在每个后台任务落盘时都会 +1：
 * 批量生成 10 件家具时，每落盘一件就把前面所有件重新下载 + 重新解析 + 重新挂载一遍。
 * 这里钉住"新物件出现不会动到已有物件的号"。
 */

const chair: AssetResourceIdentity = {
  id: "uuid-chair",
  modelPaths: ["projects/p/assets/chair/0-chair.glb"],
  mtlPath: null,
  spzPath: null,
  hdrPath: null,
};
const table: AssetResourceIdentity = {
  id: "uuid-table",
  modelPaths: ["projects/p/assets/table/0-table.glb"],
  mtlPath: null,
  spzPath: null,
  hdrPath: null,
};

describe("resourceSignature", () => {
  test("只认渲染产物：模型/部件、mtl、spz、环境贴图", () => {
    expect(resourceSignature(chair)).toBe(
      JSON.stringify([["projects/p/assets/chair/0-chair.glb"], null, null, null]),
    );
    expect(resourceSignature({ ...chair, spzPath: "world/0-world.spz" })).toContain("world/0-world.spz");
    expect(resourceSignature({ ...chair, hdrPath: "sky/0-sky.hdr" })).toContain("sky/0-sky.hdr");
    expect(resourceSignature({ ...chair, mtlPath: "chair/chair.mtl" })).toContain("chair/chair.mtl");
  });

  test("身份没变就是同一个签名（同对象重复调用可比较）", () => {
    expect(resourceSignature(chair)).toBe(resourceSignature({ ...chair }));
  });
});

describe("createResourceRevisions", () => {
  test("新资产入场景不会动到已有资产的修订号", () => {
    const revisions = createResourceRevisions();
    const chairRevision = revisions.revisionFor(chair);
    const tableRevision = revisions.revisionFor(table);
    // 第二轮扫描：家具列表里多了一件，已存在的那件必须还是原来的号（URL 不变 → loader 命中缓存）
    expect(revisions.revisionFor(chair)).toBe(chairRevision);
    expect(revisions.revisionFor(table)).toBe(tableRevision);
  });

  test("渲染产物换代（索引递增）才换号", () => {
    const revisions = createResourceRevisions();
    const before = revisions.revisionFor(chair);
    const regenerated: AssetResourceIdentity = {
      ...chair,
      modelPaths: ["projects/p/assets/chair/1-chair.glb"],
    };
    expect(revisions.revisionFor(regenerated)).toBeGreaterThan(before);
    // 换过号之后，同一个身份再问还是这个号（刷新不该反复换）
    expect(revisions.revisionFor(regenerated)).toBe(revisions.revisionFor(regenerated));
  });

  test("缺文件被 repair 回填 → 换号（错误边界与拒绝缓存都要重置）", () => {
    const revisions = createResourceRevisions();
    const missing: AssetResourceIdentity = { ...chair, modelPaths: [] };
    const before = revisions.revisionFor(missing);
    expect(revisions.revisionFor(chair)).toBeGreaterThan(before);
  });

  test("缩略图 / 自检图 / 预览图落盘不属于渲染产物，不换号", () => {
    const revisions = createResourceRevisions();
    const before = revisions.revisionFor(chair);
    // 目录里多出隐藏产物与 inspections 目录项：签名只看渲染产物路径，多出来的字段进不了签名
    const withThumbnail = {
      ...chair,
      files: [".thumb-0-chair.glb.png", "inspections", "0-chair-f2.webp"],
      thumbPath: "projects/p/assets/chair/.thumb-0-chair.glb.png",
    };
    expect(resourceSignature(withThumbnail)).toBe(resourceSignature(chair));
    expect(revisions.revisionFor(withThumbnail)).toBe(before);
  });

  test("同名重建的资产拿新号（按稳定 id，不按 slug）", () => {
    const revisions = createResourceRevisions();
    const first = revisions.revisionFor(chair);
    revisions.prune([table.id]); // chair 被删除
    const rebuilt: AssetResourceIdentity = { ...chair, id: "uuid-chair-2" };
    expect(revisions.revisionFor(rebuilt)).toBeGreaterThan(first);
  });

  test("prune 之后旧号不会被回收复用", () => {
    const revisions = createResourceRevisions();
    const first = revisions.revisionFor(chair);
    revisions.prune([]);
    expect(revisions.revisionFor({ ...chair, id: "uuid-other" })).toBeGreaterThan(first);
  });
});
