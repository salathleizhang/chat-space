import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCandidatesFile, projectFile } from "../common/libraryPaths";
import type { ChatMessage } from "../dto/chat";
import { CandidateRegistrySchema, ProjectSchema } from "../dto/library";
import {
  answerContextText,
  toAnswerMessage,
  buildChatRequestContext,
  conversationImagePaths,
  hasExplicitReferenceAnalysisIntent,
  imagePathsFromToolResult,
  listPendingGenerationTargets,
  planContextText,
  planFromToolResult,
  streamChat,
  taskIdsFromToolResult,
  toResumeMessage,
  toolErrorMessage,
  withReplyLanguageDirective,
} from "./chatService";
import { LocalFileStorage, setAssetStorage, writeJson } from "./assetStorage";

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
 * 用户的指代是「我发你的那张」，不是「这一条消息里的那张」。
 *
 * 2026-10-05 用户连着两轮：第一条带图说「直接这张图提交」，第二条**不带图**说
 * 「我不要生成参考图，直接用我发你的这张来搞」。只认最新消息的判据在第二条上拿到空
 * 数组，工具报"本条消息没有附带图片"，模型只能猜路径。这一组把判据钉在对话维度上。
 */
describe("conversationImagePaths", () => {
  const userWithImages = (paths: string[], text = "看图"): ChatMessage => ({
    role: "user",
    content: [
      ...paths.map((path) => ({ type: "image" as const, path })),
      { type: "text" as const, text },
    ],
  });

  test("跨轮次收集用户附图：按出现顺序、去重、忽略助手消息", () => {
    expect(
      conversationImagePaths([
        userWithImages(["projects/demo/source/0-a.png"]),
        { role: "assistant", content: "好的" },
        userWithImages(["projects/demo/source/1-b.png", "projects/demo/source/0-a.png"]),
        { role: "user", content: "纯文本" },
      ]),
    ).toEqual(["projects/demo/source/0-a.png", "projects/demo/source/1-b.png"]);
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
    expect(planContextText(plan)).toContain('"三只动物换绿色服装"');
  });

  test("写明只推进度，并保留步骤 id、状态与内容", () => {
    const text = planContextText(plan);
    expect(text).toContain("pass only the existing step ids and the new status");
    expect(text).toContain("the plan title, step ids and step content all stay unchanged");
    expect(text).toContain("mode=replan");
    expect(text).toContain("- [completed] s1: 取得付费同意");
    expect(text).toContain("- [in_progress] s2: 编辑参考图");
  });

  test("无标题的旧计划也有可读的占位", () => {
    expect(planContextText({ ...plan, title: undefined })).toContain("(untitled)");
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
    ).toBe('[Answer to question] Question: "是否继续？" (q-1)\nUser selection: 同意');
  });

  test("自由输入与预设选项同时出现时都保留", () => {
    const text = answerContextText({
      questionId: "q-2",
      question: "选哪些对象？",
      optionIds: ["chair"],
      labels: ["休闲椅"],
      text: "再加一个茶几",
    });
    expect(text).toContain("User selection: 休闲椅");
    expect(text).toContain("User note: 再加一个茶几");
  });

  test("只有自由输入时不留空的选项行", () => {
    const text = answerContextText({
      questionId: "q-3",
      question: "怎么办？",
      optionIds: [],
      labels: [],
      text: "先只做底板",
    });
    expect(text).toContain("User selection: (no preset option selected)");
    expect(text).toContain("User note: 先只做底板");
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
      content: '[Answer to question] Question: "是否继续？" (q-4)\nUser selection: 同意',
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

describe("withReplyLanguageDirective", () => {
  test("英文用户：指令追加在本轮最后一条 user 消息末尾", () => {
    const messages = withReplyLanguageDirective(
      [
        { role: "system", content: "当前项目：demo（demo）。" },
        { role: "user", content: "Generation every weapon to 3D" },
      ],
      [{ role: "user", content: "Generation every weapon to 3D" }],
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toContain("Generation every weapon to 3D");
    expect(messages[1]!.content).toContain("[Reply language] The user is writing in English");
  });

  /**
   * 续跑轮（`[Background tasks finished]` …）是英文写的、又接在最后，最容易把语言带跑；
   * 语言判定必须回到用户自己写的那句话上，而指令要落在**模型最后读到的那条消息**末尾。
   */
  test("续跑轮：语言按用户上一句真实发言，指令落在续跑轮末尾", () => {
    const messages = withReplyLanguageDirective(
      [
        { role: "system", content: "当前项目：demo（demo）。" },
        { role: "user", content: "做一把椅子" },
        { role: "assistant", content: "开始生成。" },
        { role: "user", content: "[Background tasks finished]\n- 3D generation (Tripo): succeeded" },
      ],
      [
        { role: "user", content: "做一把椅子" },
        { role: "assistant", content: "开始生成。" },
      ],
    );

    const last = messages[3]!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("【回复语言】");
    // 中间那条用户消息不该被动过
    expect(messages[1]!.content).toBe("做一把椅子");
  });

  test("带图消息：指令加成新的文本部件，图片部件保持原样", () => {
    const messages = withReplyLanguageDirective(
      [
        {
          role: "user",
          content: [
            { type: "image", image: "data:image/png;base64,AAAA" },
            { type: "text", text: "Please review this image." },
          ],
        },
      ],
      [
        {
          role: "user",
          content: [
            { type: "image", path: "projects/demo/source/0-image.png" },
            { type: "text", text: "Please review this image." },
          ],
        },
      ],
    );

    const content = messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error("unreachable");
    expect(content[0]).toEqual({ type: "image", image: "data:image/png;base64,AAAA" });
    expect(content.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("writing in English"),
    });
  });

  test("判定不出语言时原样返回（不注入任何东西）", () => {
    const messages: Parameters<typeof withReplyLanguageDirective>[0] = [
      { role: "user", content: "[Plan continues] 2 of 4 steps unfinished." },
    ];
    expect(withReplyLanguageDirective(messages, [
      { role: "user", content: "[Plan continues] 2 of 4 steps unfinished." },
    ])).toBe(messages);
  });
});

/**
 * 接线测试：语言判定的逻辑单测过了，不等于它真的接进了 streamChat——"注释里的约束
 * 没人接线就等于没有"。这里把上游 LLM 换成一个只抓请求体的假 fetch，跑一次真实的
 * streamChat，看发给模型的报文里到底有没有那行指令。
 */
describe("streamChat 的回复语言接线", () => {
  test("英文用户的一轮请求里，语言指令真的出现在发给模型的最后一条 user 消息上", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "chatspace-reply-language-test-"));
    const projectStorage = new LocalFileStorage(projectRoot);
    const now = new Date().toISOString();
    await writeJson(projectStorage, projectFile("demo"), ProjectSchema, {
      schemaVersion: 1,
      slug: "demo",
      name: "Demo",
      createdAt: now,
      updatedAt: now,
    });
    setAssetStorage(projectStorage);

    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    const sse = [
      'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      "",
      'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      bodies.push(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      // 上游是假的，真正的判据是"请求体里有没有那行指令"；流本身读不完也不算失败
      try {
        for await (const _chunk of streamChat({
          projectSlug: "demo",
          messages: [{ role: "user", content: "Generation every weapon to 3D" }],
          llm: { apiKey: "sk-test", baseUrl: "http://127.0.0.1:9/v1", model: "test" },
        })) {
          // 不需要消费内容
        }
      } catch {
        // 假响应不保证被上游解析器完整接受
      }
    } finally {
      globalThis.fetch = originalFetch;
      setAssetStorage(undefined);
      await rm(projectRoot, { recursive: true, force: true });
    }

    const payload = bodies.join("\n");
    expect(bodies.length).toBeGreaterThan(0);
    // 用 includes 而不是 toContain：这条报文有好几兆，失败时不该把整段吐到测试输出里
    expect(payload.includes("Generation every weapon to 3D"), "报文里没有这一轮的用户消息").toBe(
      true,
    );
    expect(
      payload.includes("The user is writing in English"),
      "报文里没有服务端判定的回复语言指令",
    ).toBe(true);
    expect(
      payload.includes("Do not switch to another language just because the internal project context"),
    ).toBe(true);
  });
});

/**
 * 思维链接线。
 *
 * `reasoning-delta` 分支很容易写了但接不上（Mastra 的分片名、payload 字段、以及
 * 往上冒的那一路任一环对不上，都表现为"静默什么都不显示"）。所以这里跑一次真实的
 * `streamChat`，钉住"上游的思维链真的变成了 reasoning 增量，而且没有混进正文"。
 */
describe("streamChat 的思维链接线", () => {
  test("上游的 reasoning-delta 变成 reasoning 增量，且不混进正文", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "chatspace-reasoning-test-"));
    const projectStorage = new LocalFileStorage(projectRoot);
    const now = new Date().toISOString();
    await writeJson(projectStorage, projectFile("demo"), ProjectSchema, {
      schemaVersion: 1,
      slug: "demo",
      name: "Demo",
      createdAt: now,
      updatedAt: now,
    });
    setAssetStorage(projectStorage);

    const originalFetch = globalThis.fetch;
    // finish_reason 必须给到 "stop"：只发 delta、不给结束原因时上游 SDK 会重试整条流，
    // 于是同一段思维链被冒出来五次（这条夹具踩过）。
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta, finish_reason: finish }] })}`;
    const sse = [
      chunk({ role: "assistant", reasoning_content: "先看场景" }),
      chunk({ reasoning_content: "再想摆放" }),
      chunk({ content: "好了" }),
      chunk({}, "stop"),
      "data: [DONE]",
      "",
    ].join("\n\n");
    globalThis.fetch = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const deltas: Array<{ type: string; text?: string }> = [];
    try {
      for await (const delta of streamChat({
        projectSlug: "demo",
        messages: [{ role: "user", content: "帮我看看" }],
        llm: { apiKey: "sk-test", baseUrl: "http://127.0.0.1:9/v1", model: "test" },
      })) {
        deltas.push(delta as { type: string; text?: string });
      }
    } catch {
      // 假响应不保证被上游解析器完整接受；判据只看已经冒出来的增量
    } finally {
      globalThis.fetch = originalFetch;
      setAssetStorage(undefined);
      await rm(projectRoot, { recursive: true, force: true });
    }

    expect(deltas.filter((delta) => delta.type === "reasoning").map((delta) => delta.text))
      .toEqual(["先看场景", "再想摆放"]);
    // 思维链不是回复正文：混进 text 就会被写进会话记录、并在下一轮回放给模型
    expect(deltas.filter((delta) => delta.type === "text").map((delta) => delta.text)).toEqual(["好了"]);
  });
});
