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

  /**
   * 参考图是用户判断"方向对不对"的唯一依据，所以图片生成与 3D 生成必须是两次
   * 付费同意：不能在图还没出来时就把 3D 的钱一起批了，也不能生成完图就顺手接着
   * 建模（2026-10 用户反馈的正是这一点）。这条口径很容易被后人合并回"一次同意"，
   * 所以钉住。
   */
  test("参考图与 3D 分两次同意，且不得在同一条回复里接着生成 3D", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("必须分成两次同意");
    expect(CREATOR_INSTRUCTIONS).toContain(
      "不得在同一条回复里生成完参考图就直接调 start-3d-batch",
    );
    // 工作台确实会把新参考图贴进对话，提示词要按这个事实说
    expect(CREATOR_INSTRUCTIONS).toContain("工作台会把新图贴进对话");
    expect(CREATOR_INSTRUCTIONS).toContain("不要接着调 start-3d-batch");
    // 旧口径：一次同意覆盖整条计划里的付费步骤
    expect(CREATOR_INSTRUCTIONS).not.toContain("同一计划的多个付费步骤可以一次同意");
  });

  /**
   * 降面（Auto low-poly）的触发口径也是产品决策：**生成完问一次，同意才减**。
   * 它很容易被后人改回"生成完自动减"（用户为此多花一次付费任务却没人问过他），
   * 或者被改回"什么都不做"（高模静默交付）。这条把两头都钉住。
   */
  test("高模生成完先问一次要不要降面，同意才调 retopologize", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("高模生成完必须先问一次要不要降面");
    expect(CREATOR_INSTRUCTIONS).toContain("modelInfo");
    expect(CREATOR_INSTRUCTIONS).toContain("Auto low-poly");
    // 卡片必须给出"不减面"这条退路，否则用户只能被迫付费
    expect(CREATOR_INSTRUCTIONS).toContain("保持高模，不减面");
    // 低模不打扰用户；完整场景跑的过程中也不问（那条任务有自己的付费计划）
    expect(CREATOR_INSTRUCTIONS).toContain("不要问，直接交付");
    expect(CREATOR_INSTRUCTIONS).toContain("跑的过程中不要问");
    // 旧口径：生成完自动减面、不需要问
    expect(CREATOR_INSTRUCTIONS).not.toContain("会自动追加一次 Tripo 减面");
  });
});
