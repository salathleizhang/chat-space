import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../dto/chat";
import {
  detectReplyLanguage,
  isWorkbenchTurn,
  replyLanguageDirective,
  replyLanguageForMessages,
} from "./replyLanguage";

/**
 * 语言判定的样本里前三条是**本机会话库里的真实句子**，其中第一条就是用户报的 bug：
 * `~/ChatSpace/sessions/s-p-mupq6eua-mupq6eum.json` 只有一条英文用户消息
 * （"Generation every weapon to 3D"），回复却是整条中文。它们必须一直是英文。
 */
describe("detectReplyLanguage", () => {
  test("英文提问判成英文（含真实失败样本）", () => {
    expect(detectReplyLanguage("Generation every weapon to 3D")).toBe("en");
    expect(
      detectReplyLanguage(
        "Extract all the furniture from this image and generate 3D models",
      ),
    ).toBe("en");
    expect(detectReplyLanguage("Please review this image.")).toBe("en");
    expect(detectReplyLanguage("Generate this world")).toBe("en");
    expect(detectReplyLanguage("make a chair")).toBe("en");
  });

  test("中文提问判成中文（含真实会话里的句子）", () => {
    expect(detectReplyLanguage("让这只金毛穿上衣服")).toBe("zh");
    expect(detectReplyLanguage("我图片已经生成完了，怎么不继续呢")).toBe("zh");
  });

  /**
   * 混排按"词"计权，不按字符比例：中文用户夹英文标识符是常态，字符比例会把它判成英文；
   * 英文用户夹中文资产名也是常态，反过来会误判。这两条把两个方向都钉住。
   */
  test("中英混排按主体语言判定", () => {
    expect(detectReplyLanguage("生成 golden-retriever 的 3D 模型")).toBe("zh");
    expect(detectReplyLanguage("把这几个模型都做成 low-poly")).toBe("zh");
    expect(detectReplyLanguage("Make the 金毛 red")).toBe("en");
  });

  test("其它文字系统按脚本判定，不当成中文或英文", () => {
    expect(detectReplyLanguage("椅子を作ってください")).toBe("ja");
    expect(detectReplyLanguage("의자를 만들어 주세요")).toBe("ko");
    expect(detectReplyLanguage("сделай мне модель стула")).toBe("ru");
    expect(detectReplyLanguage("اصنع لي كرسيا")).toBe("ar");
  });

  test("只有数字或符号时不给判定（宁可不注入，也不凭空指定语言）", () => {
    expect(detectReplyLanguage("3D")).toBe("en"); // 单个拉丁词：按安全方向落到英文
    expect(detectReplyLanguage("🚀🎨")).toBeUndefined();
    expect(detectReplyLanguage("   ")).toBeUndefined();
  });
});

describe("replyLanguageDirective", () => {
  test("中文指令用中文写，并说明英文续跑指令不代表用户改语言", () => {
    const directive = replyLanguageDirective("zh");
    expect(directive).toContain("简体中文");
    expect(directive).toContain("续跑指令");
  });

  test("英文指令点名目标语言，并禁止因为中文上下文切成中文", () => {
    const directive = replyLanguageDirective("en");
    expect(directive).toContain("writing in English");
    expect(directive).toContain(
      "Do not switch to another language just because the internal project context",
    );
    // 用户可见文字都算在内：计划标题、ask-user 卡片、资产名
    expect(directive).toContain("plan titles");
    expect(directive).toContain("ask-user card");
  });

  test("其它语言点名到具体语言，模型才知道该写哪种", () => {
    expect(replyLanguageDirective("es")).toContain("Spanish");
    expect(replyLanguageDirective("ja")).toContain("Japanese");
  });
});

describe("replyLanguageForMessages", () => {
  const user = (text: string): ChatMessage => ({ role: "user", content: text });

  test("取最近一条用户真实发言", () => {
    const language = replyLanguageForMessages([
      user("让这只金毛穿上衣服"),
      { role: "assistant", content: "好的" },
      user("Generation every weapon to 3D"),
    ]);
    expect(language?.code).toBe("en");
  });

  /**
   * 关键回归：工作台的续跑轮借 user 角色进模型、而且是英文写的。如果它算作"用户最近
   * 一条消息"，中文用户会在每次自动续跑之后收到英文回答——判定必须跳过它，回到用户
   * 自己写的那句话上。样本取自真实会话（中文用户 + `[Inspection screenshots] …`）。
   */
  test("工作台续跑轮不算用户发言：中文用户续跑后仍判中文", () => {
    expect(
      replyLanguageForMessages([
        user("让这只金毛穿上衣服"),
        user(
          "[Inspection screenshots] golden-retriever: four views (top left: ISO, top right: FRONT, bottom left: RIGHT, bottom right: TOP). Check each view.",
        ),
      ])?.code,
    ).toBe("zh");
    expect(
      replyLanguageForMessages([
        user("做几个家具"),
        user("[Background tasks finished]\n- 3D generation (Tripo): succeeded"),
      ])?.code,
    ).toBe("zh");
  });

  test("整场对话只有续跑轮时不给指令（交回提示词的通用规则）", () => {
    expect(
      replyLanguageForMessages([
        user("[Plan continues] The current plan still has 2 of 4 steps unfinished."),
      ]),
    ).toBeUndefined();
    expect(replyLanguageForMessages([{ role: "assistant", content: "…" }])).toBeUndefined();
  });

  test("带图消息只看文本部件，图片不参与判定", () => {
    expect(
      replyLanguageForMessages([
        {
          role: "user",
          content: [
            { type: "image", path: "projects/demo/source/0-image.png" },
            { type: "text", text: "Generation every weapon to 3D" },
          ],
        },
      ])?.code,
    ).toBe("en");
  });
});

describe("isWorkbenchTurn", () => {
  test("认出现有全部续跑轮标记", () => {
    expect(isWorkbenchTurn("[Self-check] chair: 4 views")).toBe(true);
    expect(isWorkbenchTurn("[Scene check] whole project scene")).toBe(true);
    expect(isWorkbenchTurn("[Close-up check] sofa")).toBe(true);
    expect(isWorkbenchTurn("[Identity check] Candidate asset reference images")).toBe(true);
    expect(isWorkbenchTurn("[Inspection screenshots] golden-retriever: four views")).toBe(true);
    expect(isWorkbenchTurn("[Background tasks finished]")).toBe(true);
    expect(isWorkbenchTurn("[Plan continues] The current plan")).toBe(true);
    expect(isWorkbenchTurn("[Reference image ready] The workbench just attached 1 new image")).toBe(
      true,
    );
  });

  test("用户自己的话不会被误判成续跑轮", () => {
    expect(isWorkbenchTurn("Generation every weapon to 3D")).toBe(false);
    expect(isWorkbenchTurn("请把 [这个] 模型改成红色")).toBe(false);
    expect(isWorkbenchTurn("hello")).toBe(false);
  });
});
