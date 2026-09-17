import { describe, expect, test } from "bun:test";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  parseIndexedName,
  parseRequestSidecarName,
  reserveIndex,
} from "./indexedFiles";

/** 只实现 reserveIndex 用到的两个方法；createExclusive 用 Set 模拟排他创建。 */
function memoryStore(initial: string[] = []) {
  const files = new Map(initial.map((path) => [path, ""]));
  return {
    files,
    async list() {
      return [...files.keys()];
    },
    async createExclusive(path: string, content: string) {
      if (files.has(path)) return false;
      files.set(path, content);
      return true;
    },
  };
}

describe("indexedFiles", () => {
  test("格式化与解析互逆", () => {
    expect(formatIndexedName(2, "bronze-arm", "glb")).toBe("2-bronze-arm.glb");
    expect(parseIndexedName("2-bronze-arm.glb")).toEqual({
      index: 2,
      slug: "bronze-arm",
      ext: "glb",
    });

    expect(formatRequestSidecarName(2, "bronze-arm")).toBe(
      ".2-bronze-arm-request.json",
    );
    expect(parseRequestSidecarName(".2-bronze-arm-request.json")).toEqual({
      index: 2,
      slug: "bronze-arm",
    });
  });

  test("多段扩展名（如 full_res.spz 风格）可解析", () => {
    expect(parseIndexedName("1-world.pano.png")).toEqual({
      index: 1,
      slug: "world",
      ext: "pano.png",
    });
  });

  test("非索引文件返回 null", () => {
    expect(parseIndexedName("asset.json")).toBeNull();
    expect(parseIndexedName("project.json")).toBeNull();
    expect(parseRequestSidecarName("2-bronze-arm.glb")).toBeNull();
  });

  test("nextIndex 综合可见产物与侧写，空目录从 0 开始", () => {
    expect(nextIndex([])).toBe(0);
    expect(nextIndex(["asset.json"])).toBe(0);
    expect(nextIndex(["0-arm.png", ".1-arm-request.json"])).toBe(2);
    expect(nextIndex(["0-arm.png", "0-arm.glb"])).toBe(1);
  });
});

describe("reserveIndex", () => {
  test("空目录占用 0，并落一份调用方给的占位内容", async () => {
    const store = memoryStore();
    expect(
      await reserveIndex(store, "dir", "ref", (index) => `queued:${index}`),
    ).toBe(0);
    expect([...store.files]).toEqual([["dir/.0-ref-request.json", "queued:0"]]);
    // 占位名必须满足侧写解析规则，否则并发调用根本看不到它已被占用
    expect(parseRequestSidecarName(".0-ref-request.json")).toEqual({
      index: 0,
      slug: "ref",
    });
  });

  test("占位已存在时顺延到下一个索引", async () => {
    const store = memoryStore(["dir/0-ref.png", "dir/.0-ref-request.json"]);
    expect(await reserveIndex(store, "dir", "ref", () => "x")).toBe(1);
    expect(await reserveIndex(store, "dir", "ref", () => "x")).toBe(2);
  });

  test("并发占用同一个 slug 时各自拿到不同索引", async () => {
    const store = memoryStore();
    const reserve = () => reserveIndex(store, "dir", "ref", () => "x");
    const indexes = await Promise.all([reserve(), reserve(), reserve()]);
    expect([...indexes].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(store.files.size).toBe(3);
  });

  test("不同 slug 可以共用同一索引", async () => {
    const store = memoryStore();
    const [a, b] = await Promise.all([
      reserveIndex(store, "dir", "ref", () => "x"),
      reserveIndex(store, "dir", "orange-cat-ref", () => "x"),
    ]);
    expect([a, b]).toEqual([0, 0]);
  });
});
