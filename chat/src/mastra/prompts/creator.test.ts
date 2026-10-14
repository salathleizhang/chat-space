import { describe, expect, test } from "bun:test";
import { CREATOR_INSTRUCTIONS } from "./creator";

describe("creator 回复协议", () => {
  test("约束自由文本格式，并把交互状态留给结构化工作台组件", () => {
    expect(CREATOR_INSTRUCTIONS).toContain("GitHub Flavored Markdown");
    expect(CREATOR_INSTRUCTIONS).toContain("do not use nested lists");
    expect(CREATOR_INSTRUCTIONS).toContain("Do not output HTML");
    expect(CREATOR_INSTRUCTIONS).toContain("are displayed by dedicated workbench components");
  });

  /**
   * 语言跟随用户：提示词原先硬编码"回复使用简体中文"，英文用户会收到中文回答。
   * 这条把口径钉住，避免被改回固定语言；付费同意卡片的按钮文字也是用户可见文字。
   */
  test("回复语言跟随用户最近一条消息，不固定中文", () => {
    expect(CREATOR_INSTRUCTIONS).not.toContain("Always reply in Simplified Chinese");
    expect(CREATOR_INSTRUCTIONS).toContain(
      "The reply language follows the user's most recent message",
    );
    expect(CREATOR_INSTRUCTIONS).toContain("Approve / Stop");
  });

  /**
   * 2026-10-06 用户反馈：说英文收到中文回复。根因是上下文里的语言信号本来就是混的——
   * 服务端注入的项目上下文/计划/工具返回值是内部数据，工作台续跑指令是英文——提示词里一条
   * "跟随用户"压不住它。服务端现在自己判定语言、并在本轮最后一条用户消息末尾追加一行
   * 指令（`replyLanguage.ts`）；提示词这边要说明两件事：内部上下文的语言**不代表**回复
   * 语言，服务端那行指令才是权威判定。
   */
  test("内部上下文的语言不代表回复语言，服务端追加的指令才算", () => {
    expect(CREATOR_INSTRUCTIONS).toContain(
      "The language of the context does not determine the reply language",
    );
    expect(CREATOR_INSTRUCTIONS).toContain("are fixed in English");
    expect(CREATOR_INSTRUCTIONS).toContain("end of the last user message of the turn");
    expect(CREATOR_INSTRUCTIONS).toContain("authoritative determination");
  });

  /**
   * 自检的触发口径是产品决策，写在提示词里就容易被后人"顺手"改回"生成完就查"。
   * 这几条把口径钉住：单模型不查、用户点名才查、整场景检查是唯一的自动例外。
   */
  test("自检只在用户要求时做，整场景检查是唯一的自动例外", () => {
    expect(CREATOR_INSTRUCTIONS).toContain(
      "Call it only when the user explicitly asks for an inspection",
    );
    expect(CREATOR_INSTRUCTIONS).toContain(
      "a finished single-model generation gets no visual self-check",
    );
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
    expect(CREATOR_INSTRUCTIONS).toContain("must be two separate consents");
    expect(CREATOR_INSTRUCTIONS).toContain(
      "you must not call start-3d-batch in the same reply that just finished generating a reference image",
    );
    // 工作台确实会把新参考图贴进对话，提示词要按这个事实说
    expect(CREATOR_INSTRUCTIONS).toContain(
      "the workbench posts the new image into the conversation",
    );
    expect(CREATOR_INSTRUCTIONS).toContain(
      "This reply ends here; do not follow it with start-3d-batch",
    );
    // 旧口径：一次同意覆盖整条计划里的付费步骤
    expect(CREATOR_INSTRUCTIONS).not.toContain(
      "All paid steps of one plan can be approved at once",
    );
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
    expect(CREATOR_INSTRUCTIONS).toContain("A single object, subject complete and unoccluded");
    expect(CREATOR_INSTRUCTIONS).toContain("mode=edit");
    expect(CREATOR_INSTRUCTIONS).toContain("mode=generate");
    expect(CREATOR_INSTRUCTIONS).toContain("the one exception");
    expect(CREATOR_INSTRUCTIONS).toContain("use the original image you uploaded directly");
    expect(CREATOR_INSTRUCTIONS).toContain(
      'never "generate one and see, swap it if it is no good"',
    );
    // Hi3D 只吃 Seedream 产物的公网 URL，原图喂不进去
    expect(CREATOR_INSTRUCTIONS).toContain("the original image cannot be fed in");
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
    expect(CREATOR_INSTRUCTIONS).toContain(
      "their choice is final and your tier judgment is void",
    );
    expect(CREATOR_INSTRUCTIONS).toContain("Only when they have not said which image to use");
    expect(CREATOR_INSTRUCTIONS).toContain(
      "let them make the call; do not change their mind for them",
    );
  });

  /**
   * 2026-10-02 用户反馈：参考图生成完，Agent 在正文里写「告诉我方向对不对」，
   * 用户必须先手打一句「继续」才看到那张 3D 同意卡片。需要用户拍板的事只有一条
   * 出路——ask-user 卡片；正文里不许出现等用户打字才能推进的话。
   */
  test("需要用户拍板只能用卡片，不许让用户手打一句来推进", () => {
    expect(CREATOR_INSTRUCTIONS).toContain(
      "Never make the user type a sentence to move the flow forward",
    );
    expect(CREATOR_INSTRUCTIONS).toContain("reply to continue");
    expect(CREATOR_INSTRUCTIONS).toContain("tell me whether the direction is right");
    // 图片落盘后工作台会自动续跑一轮：提示词要按这个事实说，别把图当成"等用户回话"
    expect(CREATOR_INSTRUCTIONS).toContain("[Reference image ready]");
    // 失败也一样：同一条回复里就要把"重试/换参数/放弃"弹成卡片，别只报一句错
    expect(CREATOR_INSTRUCTIONS).toContain("When a step fails");
    expect(CREATOR_INSTRUCTIONS).toContain(
      "retry / change parameters or provider / give up",
    );
  });

  /**
   * 降面（Auto low-poly）的触发口径也是产品决策：**生成完问一次，同意才减**。
   * 它很容易被后人改回"生成完自动减"（用户为此多花一次付费任务却没人问过他），
   * 或者被改回"什么都不做"（高模静默交付）。这条把两头都钉住。
   */
  test("高模生成完先问一次要不要降面，同意才调 retopologize", () => {
    expect(CREATOR_INSTRUCTIONS).toContain(
      "After a high-poly model is generated you must ask once whether to decimate",
    );
    expect(CREATOR_INSTRUCTIONS).toContain("modelInfo");
    expect(CREATOR_INSTRUCTIONS).toContain("Auto low-poly");
    // 卡片必须给出"不减面"这条退路，否则用户只能被迫付费
    expect(CREATOR_INSTRUCTIONS).toContain("Keep high-poly, no decimation");
    // 低模不打扰用户；完整场景跑的过程中也不问（那条任务有自己的付费计划）
    expect(CREATOR_INSTRUCTIONS).toContain("do not ask — deliver directly");
    expect(CREATOR_INSTRUCTIONS).toContain(
      "Do not ask while a full scene (start-scene-job) is running",
    );
    // 旧口径：生成完自动减面、不需要问
    expect(CREATOR_INSTRUCTIONS).not.toContain("automatically appends a Tripo decimation");
  });
});
