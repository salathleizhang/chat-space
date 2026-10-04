import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCandidatesFile } from "../common/libraryPaths";
import type { ChatMessage } from "../dto/chat";
import { CandidateRegistrySchema } from "../dto/library";
import {
  answerContextText,
  toAnswerMessage,
  buildChatRequestContext,
  hasExplicitReferenceAnalysisIntent,
  hasExplicitUploadAsReferenceIntent,
  imagePathsFromToolResult,
  listPendingGenerationTargets,
  planContextText,
  planFromToolResult,
  taskIdsFromToolResult,
  toResumeMessage,
  toolErrorMessage,
  uploadAsReferenceContextLine,
} from "./chatService";
import { LocalFileStorage, writeJson } from "./assetStorage";

const root = await mkdtemp(join(tmpdir(), "chatspace-chat-context-test-"));
const storage = new LocalFileStorage(root);
afterAll(() => rm(root, { recursive: true, force: true }));

function imageMessage(text: string): ChatMessage {
  return {
    role: "user",
    content: [
      { type: "image", path: "projects/demo/source/0-image.png" },
      { type: "text", text },
    ],
  };
}

describe("hasExplicitReferenceAnalysisIntent", () => {
  test("普通看图、截图排错和设计评价都不激活参考图工作流", () => {
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("请查看这张图片。"))).toBe(false);
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("这个报错为什么出现？"))).toBe(false);
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("你觉得这个界面设计怎么样？"))).toBe(false);
    // 英文负例：有图片也有 3D/模型字眼，但没有任何"提取/生成"意图。
    expect(
      hasExplicitReferenceAnalysisIntent(imageMessage("What do you think of this interior design?")),
    ).toBe(false);
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("Why does this error appear?"))).toBe(false);
    expect(
      hasExplicitReferenceAnalysisIntent(imageMessage("Can you make this 3D model look better?")),
    ).toBe(false);
    expect(
      hasExplicitReferenceAnalysisIntent(imageMessage("Is this 3D model from this photo correct?")),
    ).toBe(false);
  });

  test("明确要求参考图分析或从图片生成资产时才激活", () => {
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("请分析这张参考图，提取可生成的资产"))).toBe(true);
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("把这张图片做成 3D 模型"))).toBe(true);
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("提取图里的桌椅对象并分别建模"))).toBe(true);
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("把这张图一键生成完整场景"))).toBe(true);
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("把这张图生成完整场景"))).toBe(true);
    expect(hasExplicitReferenceAnalysisIntent(imageMessage("直接用这张图生成世界"))).toBe(false);
    expect(
      hasExplicitReferenceAnalysisIntent(
        imageMessage("把这个图片的每个家具拆出来，生成单个的参考图"),
      ),
    ).toBe(true);
  });

  test("英文语序也要激活（2026-10 实测漏判导致 analyze-reference 整轮缺失）", () => {
    // 真实事故原话：判定为 false 时工具集里没有 analyze-reference，
    // agent 只能自己编 slug 去调 mode=edit，批量 404。
    expect(
      hasExplicitReferenceAnalysisIntent(
        imageMessage("Extract all the furniture from this image and generate 3D models"),
      ),
    ).toBe(true);
    expect(
      hasExplicitReferenceAnalysisIntent(
        imageMessage("extract every object from the photo and make 3d assets"),
      ),
    ).toBe(true);
    expect(
      hasExplicitReferenceAnalysisIntent(
        imageMessage("pull the items out of this image as 3d models"),
      ),
    ).toBe(true);
    expect(
      hasExplicitReferenceAnalysisIntent(
        imageMessage("generate 3D models from the objects in this photo"),
      ),
    ).toBe(true);
    expect(
      hasExplicitReferenceAnalysisIntent(
        imageMessage("generate 3D models of the furniture in this picture"),
      ),
    ).toBe(true);
    expect(
      hasExplicitReferenceAnalysisIntent(imageMessage("Turn this photo into 3D models")),
    ).toBe(true);
  });
});

/**
 * 2026-10-05 用户连着两轮说了「不要生成参考图，直接用这张图来生成」「你不能直接拿我
 * 给你的图片来生成吗」，Agent 两轮都用自己的判断（斜侧视、带草地天空、背面没信息）
 * 把原图换成了"更干净的参考图"。判断没错，错在它不是决策者——用户已经表态用哪张图。
 * 所以在决策点由服务端把话说明白，而不是只写在提示词里等模型自觉。
 *
 * 正例直接取用户原话：这条正则要是退化，用户会第三次被同样的方式覆盖。
 */
describe("hasExplicitUploadAsReferenceIntent", () => {
  test("用户原话（两轮都被无视的那两句）必须命中", () => {
    expect(
      hasExplicitUploadAsReferenceIntent(
        imageMessage("不要生成参考图，直接用这张图来生成，提交模型的生成请求"),
      ),
    ).toBe(true);
    expect(
      hasExplicitUploadAsReferenceIntent(
        imageMessage("不是，为什么还要生成图片，你不能直接拿我给你的图片来生成吗"),
      ),
    ).toBe(true);
    // "我想要提交的参考图是这张"：换一种自然说法，同样是点名用哪张
    expect(
      hasExplicitUploadAsReferenceIntent(imageMessage("我想要提交的参考图是这张")),
    ).toBe(true);
    // 英文同义说法
    expect(
      hasExplicitUploadAsReferenceIntent(imageMessage("Don't generate a reference image, use my photo directly")),
    ).toBe(true);
    expect(
      hasExplicitUploadAsReferenceIntent(imageMessage("Use the uploaded image as-is for the 3D model")),
    ).toBe(true);
  });

  test("普通看图、设计讨论、只问模型效果都不命中", () => {
    expect(hasExplicitUploadAsReferenceIntent(imageMessage("请查看这张图片。"))).toBe(false);
    expect(hasExplicitUploadAsReferenceIntent(imageMessage("用这张图片看看这个设计怎么样"))).toBe(false);
    expect(hasExplicitUploadAsReferenceIntent(imageMessage("这张图是什么？"))).toBe(false);
    expect(hasExplicitUploadAsReferenceIntent(imageMessage("你生成的跟现在没有区别啊"))).toBe(false);
    expect(
      hasExplicitUploadAsReferenceIntent(imageMessage("Can you make this 3D model look better?")),
    ).toBe(false);
    // 没有生成类动词的"这张图"不算表态
    expect(hasExplicitUploadAsReferenceIntent(imageMessage("直接看这张图就行"))).toBe(false);
  });

  test("整张图做完整场景是另一条路，不在本判据里抢答", () => {
    // 场景那条走 analyze-reference，这里不能把模型往"登记成单物体参考图"上带
    expect(
      hasExplicitUploadAsReferenceIntent(imageMessage("直接用这张图生成完整场景")),
    ).toBe(false);
    expect(
      hasExplicitUploadAsReferenceIntent(imageMessage("把这张图一键生成整个场景，不要生成参考图")),
    ).toBe(false);
  });

  test("没有文字时一律不命中（纯图片消息不该被当成表态）", () => {
    expect(
      hasExplicitUploadAsReferenceIntent({
        role: "user",
        content: [{ type: "image", path: "projects/demo/source/0-image.png" }],
      }),
    ).toBe(false);
  });

  /**
   * 注入上下文的那段话是**唯一直接压住模型判断的东西**，措辞必须硬：说"建议优先
   * 使用原图"就等于没说，用户会第三次遇到同一件事。
   */
  test("上下文那句话要压住判断，且 Hi3D 走另一条", () => {
    const line = uploadAsReferenceContextLine(
      "projects/demo/source/6-image.png",
      "tripo-direct",
    );
    expect(line).toContain("projects/demo/source/6-image.png");
    expect(line).toContain("attach-source-image");
    expect(line).toContain("不要");
    expect(line).toContain("不要替他改主意");
    // 非 Hi3D 时不该出现渠道例外，否则模型会以为可以退回先生成
    expect(line).not.toContain("hi3d");

    const hi3d = uploadAsReferenceContextLine(
      "projects/demo/source/6-image.png",
      "hi3d-volc",
    );
    expect(hi3d).toContain("原图喂不进去");
  });
});

describe("imagePathsFromToolResult", () => {
  test("只提取参考图生成结果中的库内路径并去重", () => {
    expect(
      imagePathsFromToolResult("generate-reference-images", {
        images: [
          "projects/demo/source/0-ref.png",
          "projects/demo/source/0-ref.png",
          "../../secret.png",
        ],
        sidecar: "projects/demo/source/0-ref.request.json",
        channel: "volcengine",
      }),
    ).toEqual(["projects/demo/source/0-ref.png"]);
  });

  test("支持参考图编辑的单图结果，忽略其他工具", () => {
    expect(
      imagePathsFromToolResult("edit-reference-image", {
        image: "projects/demo/source/1-chair-ref.webp",
      }),
    ).toEqual(["projects/demo/source/1-chair-ref.webp"]);
    expect(
      imagePathsFromToolResult("generate-skybox", {
        image: "projects/demo/assets/sky/2-sky.png",
      }),
    ).toEqual(["projects/demo/assets/sky/2-sky.png"]);
    expect(
      imagePathsFromToolResult("start-3d-batch", {
        images: ["projects/demo/source/0-ref.png"],
      }),
    ).toBeUndefined();
  });

  test("统一生图工具的 plate 模式也能把底板图片交给工作台", () => {
    expect(
      imagePathsFromToolResult("generate-reference-images", {
        mode: "plate",
        images: ["projects/demo/source/2-plate.png"],
      }),
    ).toEqual(["projects/demo/source/2-plate.png"]);
  });

  test("独立干净底板工具也能把结果交给工作台", () => {
    expect(
      imagePathsFromToolResult("generate-clean-plate", {
        images: ["projects/demo/source/3-plate.png"],
      }),
    ).toEqual(["projects/demo/source/3-plate.png"]);
  });
});

describe("taskIdsFromToolResult", () => {
  test("统一提取单任务与批量任务 id", () => {
    expect(
      taskIdsFromToolResult({ task: { id: "task-1", status: "running" } }),
    ).toEqual(["task-1"]);
    expect(
      taskIdsFromToolResult({
        tasks: [{ id: "task-2" }, { id: "task-3" }, { id: "task-2" }],
      }),
    ).toEqual(["task-2", "task-3"]);
    expect(
      taskIdsFromToolResult({ runId: "workflow-run", result: { task: { id: "task-4" } } }),
    ).toEqual(["task-4"]);
  });

  test("普通同步工具结果不产生后台任务 id", () => {
    expect(taskIdsFromToolResult({ images: ["projects/demo/source/0.png"] })).toBeUndefined();
  });
});

describe("listPendingGenerationTargets", () => {
  test("跨轮次恢复已生成参考图的待发布对象", async () => {
    await writeJson(storage, projectCandidatesFile("demo"), CandidateRegistrySchema, {
      schemaVersion: 1,
      objects: [
        {
          slug: "table",
          name: "胡桃木餐桌",
          description: "圆角餐桌",
          sourceImages: ["projects/demo/source/0-table-ref.png"],
        },
      ],
      updatedAt: new Date().toISOString(),
    });
    expect(await listPendingGenerationTargets(storage, "demo")).toMatchObject([
      { slug: "table", sourceImages: ["projects/demo/source/0-table-ref.png"] },
    ]);
  });

  /**
   * `candidates.json` 是项目级单例：新建会话时上一轮的未完成对象会被一起读出来。
   * 若原样交给模型，模型就会拿着上一轮的参考图开工——用户报的正是这条。所以只列
   * 本会话登记的；判据是登记时刻 vs 会话开始时刻。
   */
  test("新会话只列本会话登记的目标，上一轮留下的不再继承", async () => {
    const sessionStart = Date.parse("2026-10-02T12:00:00.000Z");
    await writeJson(storage, projectCandidatesFile("scoped"), CandidateRegistrySchema, {
      schemaVersion: 1,
      objects: [
        {
          slug: "old-chair",
          name: "上一轮的椅子",
          description: "旧目标",
          sourceImages: ["projects/scoped/source/0-chair-ref.png"],
          createdAt: new Date(sessionStart - 3_600_000).toISOString(),
        },
        {
          slug: "new-table",
          name: "本轮的桌子",
          description: "新目标",
          sourceImages: ["projects/scoped/source/1-table-ref.png"],
          createdAt: new Date(sessionStart + 60_000).toISOString(),
        },
      ],
      updatedAt: new Date(sessionStart + 60_000).toISOString(),
    });

    const targets = await listPendingGenerationTargets(storage, "scoped", sessionStart);
    expect(targets.map((target) => target.slug)).toEqual(["new-table"]);
  });

  test("旧 candidates.json 没有 createdAt：一律算早就有的，不倒进新会话", async () => {
    await writeJson(storage, projectCandidatesFile("legacy"), CandidateRegistrySchema, {
      schemaVersion: 1,
      objects: [
        {
          slug: "table",
          name: "胡桃木餐桌",
          description: "圆角餐桌",
          sourceImages: ["projects/legacy/source/0-table-ref.png"],
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      await listPendingGenerationTargets(
        storage,
        "legacy",
        Date.parse("2026-10-02T12:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  test("客户端没带会话时间：保持原行为（不误伤同会话的正常续跑）", async () => {
    await writeJson(storage, projectCandidatesFile("legacy-b"), CandidateRegistrySchema, {
      schemaVersion: 1,
      objects: [
        {
          slug: "table",
          name: "胡桃木餐桌",
          description: "圆角餐桌",
          sourceImages: ["projects/legacy-b/source/0-table-ref.png"],
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      (await listPendingGenerationTargets(storage, "legacy-b")).map((target) => target.slug),
    ).toEqual(["table"]);
  });
});

describe("toResumeMessage", () => {
  test("Agent 自发续跑的检查图内联成 user 部件，只活在本次请求上下文里", async () => {
    const path = "projects/demo/assets/dog/inspections/check.png";
    await storage.writeBytes(path, new Uint8Array([1, 2, 3]));
    const message = await toResumeMessage(storage, {
      kind: "inspection",
      text: "[Self-check] dog: four views. Check each view.",
      images: [path],
    });
    expect(message).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining("[Self-check]") },
        {
          type: "image",
          image: expect.stringContaining("data:image/png;base64,"),
        },
      ],
    });
  });

  test("没有图片的续跑（后台任务完成）只带指令文本", async () => {
    const message = await toResumeMessage(storage, {
      kind: "tasks",
      text: "[Background tasks finished]\n- 3D 生成：椅子: succeeded",
    });
    expect(message).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "[Background tasks finished]\n- 3D 生成：椅子: succeeded",
        },
      ],
    });
  });
});

describe("toolErrorMessage", () => {
  test("兼容 tool-result 与 tool-error 的嵌套错误形状", () => {
    expect(toolErrorMessage({ error: { message: "参考图不存在" } })).toBe(
      "参考图不存在",
    );
    expect(toolErrorMessage(new Error("network error"))).toBe("network error");
    expect(toolErrorMessage({ result: { cause: "invalid schema" } })).toBe(
      "invalid schema",
    );
  });
});

describe("planFromToolResult", () => {
  test("只透传 update-plan 的合法完整计划，并为旧形状补 revision", () => {
    const result = {
      plan: {
        schemaVersion: 1,
        title: "建模",
        steps: [{ id: "model", content: "生成模型", status: "in_progress" }],
        updatedAt: new Date().toISOString(),
      },
    };
    expect(planFromToolResult("update-plan", result)).toMatchObject({
      revision: 1,
      title: "建模",
    });
    expect(planFromToolResult("start-3d-batch", result)).toBeUndefined();
    expect(planFromToolResult("update-plan", { plan: { bad: true } })).toBeUndefined();
  });
});

describe("planContextText", () => {
  const plan = {
    schemaVersion: 1 as const,
    revision: 2,
    title: "三只动物换绿色服装",
    steps: [
      { id: "s1", content: "取得付费同意", status: "completed" as const },
      { id: "s2", content: "编辑参考图", status: "in_progress" as const },
    ],
    updatedAt: new Date().toISOString(),
  };

  test("把当前标题交给模型，普通更新才不必靠撞 409 才知道标题不可改", () => {
    expect(planContextText(plan)).toContain("「三只动物换绿色服装」");
  });

  test("写明只推进度，并保留步骤 id、状态与内容", () => {
    const text = planContextText(plan);
    expect(text).toContain("只传已有步骤 id 与新 status");
    expect(text).toContain("计划标题、步骤 id 和步骤内容都保持不变");
    expect(text).toContain("mode=replan");
    expect(text).toContain("- [completed] s1: 取得付费同意");
    expect(text).toContain("- [in_progress] s2: 编辑参考图");
  });

  test("无标题的旧计划也有可读的占位", () => {
    expect(planContextText({ ...plan, title: undefined })).toContain("（无标题）");
  });
});

describe("answerContextText", () => {
  test("把卡片点选还原成模型可读的回答", () => {
    expect(
      answerContextText({
        questionId: "q-1",
        question: "是否继续？",
        optionIds: ["approve"],
        labels: ["同意"],
      }),
    ).toBe("【对提问的回答】问题：「是否继续？」（q-1）\n用户选择：同意");
  });

  test("自由输入与预设选项同时出现时都保留", () => {
    const text = answerContextText({
      questionId: "q-2",
      question: "选哪些对象？",
      optionIds: ["chair"],
      labels: ["休闲椅"],
      text: "再加一个茶几",
    });
    expect(text).toContain("用户选择：休闲椅");
    expect(text).toContain("用户补充：再加一个茶几");
  });

  test("只有自由输入时不留空的选项行", () => {
    const text = answerContextText({
      questionId: "q-3",
      question: "怎么办？",
      optionIds: [],
      labels: [],
      text: "先只做底板",
    });
    expect(text).toContain("用户选择：（未选择预设选项）");
    expect(text).toContain("用户补充：先只做底板");
  });

  test("回答接成本轮上下文：借 user 角色，但工作台不把它写进会话历史", () => {
    expect(
      toAnswerMessage({
        questionId: "q-4",
        question: "是否继续？",
        optionIds: ["approve"],
        labels: ["同意"],
      }),
    ).toEqual({
      role: "user",
      content: "【对提问的回答】问题：「是否继续？」（q-4）\n用户选择：同意",
    });
  });
});

describe("buildChatRequestContext", () => {
  test("把 Seed3D key 注入 Agent 工具上下文", () => {
    const context = buildChatRequestContext(
      {
        projectSlug: "demo",
        messages: [{ role: "user", content: "生成 3D" }],
        llm: { apiKey: "sk-llm" },
        seed3dApiKey: "ark-seed3d-key",
      },
      [],
      false,
    );

    expect(context.get<string>("seed3dApiKey")).toBe("ark-seed3d-key");
  });

  test("把当前图片生成模型注入 Agent 工具上下文", () => {
    const context = buildChatRequestContext(
      {
        projectSlug: "demo",
        messages: [{ role: "user", content: "修改天空盒" }],
        llm: { apiKey: "sk-llm" },
        imageGenerateModel: "seedream-5-pro",
      },
      [],
      false,
    );

    expect(context.get<string>("imageGenerateModel")).toBe("seedream-5-pro");
  });
});
