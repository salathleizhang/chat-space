import { describe, expect, test } from "bun:test";
import { CREATOR_INSTRUCTIONS } from "./creator";

describe("creator 回复协议", () => {
  test("约束自由文本格式，并把交互状态留给结构化工作台组件", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("GitHub Flavored Markdown");
    expect(CREATOR_INSTRUCTIONS).toContain("不使用嵌套列表");
    expect(CREATOR_INSTRUCTIONS).toContain("不输出 HTML");
    expect(CREATOR_INSTRUCTIONS).toContain("由工作台组件单独展示");
  });
});
