import { describe, expect, test } from "bun:test";
import { isSafeFileName } from "./safeName";

describe("safeName", () => {
  test("正常文件名通过", () => {
    expect(isSafeFileName("chair_diffuse.png")).toBe(true);
    expect(isSafeFileName("chair.mtl")).toBe(true);
  });

  test("路径穿越被拒绝", () => {
    expect(isSafeFileName("..")).toBe(false);
    expect(isSafeFileName("../evil.png")).toBe(false);
  });

  test("含路径分隔符被拒绝", () => {
    expect(isSafeFileName("a/b.png")).toBe(false);
    expect(isSafeFileName("a\\b.png")).toBe(false);
  });

  test("隐藏文件被拒绝（避免伪装成侧写文件）", () => {
    expect(isSafeFileName(".secret")).toBe(false);
    expect(isSafeFileName(".1-arm-request.json")).toBe(false);
  });
});
