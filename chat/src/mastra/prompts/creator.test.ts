import { describe, expect, test } from "bun:test";
import { CREATOR_INSTRUCTIONS } from "./creator";

describe("creator 回复协议", () => {
  test("约束自由文本格式，并把交互状态留给结构化工作台组件", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("GitHub Flavored Markdown");
    expect(CREATOR_INSTRUCTIONS).toContain("不使用嵌套列表");
    expect(CREATOR_INSTRUCTIONS).toContain("不输出 HTML");
    expect(CREATOR_INSTRUCTIONS).toContain("由工作台组件单独展示");
  });

  /**
   * 语言跟随用户：提示词原先硬编码"回复使用简体中文"，英文用户会收到中文回答。
   * 这条把口径钉住，避免被改回固定语言；付费同意卡片的按钮文字也是用户可见文字。
   */
  test("回复语言跟随用户最近一条消息，不固定中文", () => {
    expect(CREATOR_INSTRUCTIONS).not.toContain("回复使用简体中文");
    expect(CREATOR_INSTRUCTIONS).toContain("回复语言跟随用户最近一条消息");
    expect(CREATOR_INSTRUCTIONS).toContain("Approve / Stop");
  });

  /**
   * 自检的触发口径是产品决策，写在提示词里就容易被后人"顺手"改回"生成完就查"。
   * 这几条把口径钉住：单模型不查、用户点名才查、整场景检查是唯一的自动例外。
   */
  test("自检只在用户要求时做，整场景检查是唯一的自动例外", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("只在用户明确要求检查");
    expect(CREATOR_INSTRUCTIONS).toContain("单模型生成完成不做视觉自检");
    expect(CREATOR_INSTRUCTIONS).toContain('target="scene"');
    // 旧口径不该再出现：工具已改名，提示词里也不该再写"生成完就自检"
    expect(CREATOR_INSTRUCTIONS).not.toContain("inspect-asset");
  });
});
