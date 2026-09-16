import { describe, expect, test } from "bun:test";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  parseIndexedName,
  parseRequestSidecarName,
} from "./indexedFiles";

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
