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
   * 上传直连：用户本条上传的原图本身就是参考图，不该再花钱画一张。这一档也是
   * "两次同意"纪律的**唯一例外**，而例外必须窄——只有 attach-source-image 这条
   * 免费通路成立时才允许在参考图落盘前取得 3D 生成的同意（本来就没有新图要落盘、
   * 也没有"方向对不对"要看）；生成出来的参考图仍走完整的两步。
   *
   * 钉住三件事：① 三档判据在（直接绑定 / 隔离 / 重新生成）、② 例外写明"唯一"且
   * 附着在这一档上、③ 判断发生在花钱之前，不是"先生成出来看看、不行再换"（那等于
   * 给差输入付两次费）。后续调整很容易把它放宽成"上传的图都不用二次确认"，所以
   * 连措辞一起钉。
   */
  test("上传原图可直连，但例外窄、判档在花钱之前", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("attach-source-image");
    expect(CREATOR_INSTRUCTIONS).toContain("单件物体、主体完整无遮挡");
    expect(CREATOR_INSTRUCTIONS).toContain("mode=edit");
    expect(CREATOR_INSTRUCTIONS).toContain("mode=generate");
    expect(CREATOR_INSTRUCTIONS).toContain("唯一例外");
    expect(CREATOR_INSTRUCTIONS).toContain("直接使用你上传的原图");
    expect(CREATOR_INSTRUCTIONS).toContain('不要"先生成出来看看、不行再换一张"');
    // Hi3D 只吃 Seedream 产物的公网 URL，原图喂不进去
    expect(CREATOR_INSTRUCTIONS).toContain("原图喂不进去");
  });

  /**
   * 2026-10-05：用户连着两轮说「不要生成参考图，直接用这张图来生成」，Agent 两轮都用
   * 自己的档位判断把它换成了"更干净的参考图"（那张照片斜侧视、带草地和天空、背面没有
   * 信息——判断本身没错）。错在**它不是决策者**：用户已经表态用哪张图，那是产品选择。
   *
   * 这条优先级很容易被后人改回"AI 综合判断更优"，所以把措辞钉死；服务端还会在同一
   * 决策点注入一段更硬的话（见 chatService 的 uploadAsReferenceContextLine）。
   */
  test("用户点名用哪张图时，Agent 的档位判断作废", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("他的选择是最终决定，你的档位判断作废");
    expect(CREATOR_INSTRUCTIONS).toContain("他没表态时");
    expect(CREATOR_INSTRUCTIONS).toContain("由他拍板，不是你替他改主意");
  });

  /**
   * 2026-10-02 用户反馈：参考图生成完，Agent 在正文里写「告诉我方向对不对」，
   * 用户必须先手打一句「继续」才看到那张 3D 同意卡片。需要用户拍板的事只有一条
   * 出路——ask-user 卡片；正文里不许出现等用户打字才能推进的话。
   */
  test("需要用户拍板只能用卡片，不许让用户手打一句来推进", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("永远不要让用户靠手打一句话来推进流程");
    expect(CREATOR_INSTRUCTIONS).toContain("请回复继续");
    expect(CREATOR_INSTRUCTIONS).toContain("告诉我方向对不对");
    // 图片落盘后工作台会自动续跑一轮：提示词要按这个事实说，别把图当成"等用户回话"
    expect(CREATOR_INSTRUCTIONS).toContain("[Reference image ready]");
    // 失败也一样：同一条回复里就要把"重试/换参数/放弃"弹成卡片，别只报一句错
    expect(CREATOR_INSTRUCTIONS).toContain("某一步失败时");
    expect(CREATOR_INSTRUCTIONS).toContain("重试 / 换参数或渠道 / 放弃");
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
