import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCandidatesFile } from "../common/libraryPaths";
import type { ChatMessage } from "../dto/chat";
import { CandidateRegistrySchema } from "../dto/library";
import {
  answerPartText,
  buildChatRequestContext,
  hasExplicitReferenceAnalysisIntent,
  imagePathsFromToolResult,
  listPendingGenerationTargets,
  planContextText,
  planFromToolResult,
  taskIdsFromToolResult,
  toResumeMessage,
  toolErrorMessage,
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

describe("answerPartText", () => {
  test("把卡片点选还原成模型可读的回答", () => {
    expect(
      answerPartText({
        type: "answer",
        questionId: "q-1",
        question: "是否继续？",
        optionIds: ["approve"],
        labels: ["同意"],
      }),
    ).toBe("【对提问的回答】问题：「是否继续？」（q-1）\n用户选择：同意");
  });

  test("自由输入与预设选项同时出现时都保留", () => {
    const text = answerPartText({
      type: "answer",
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
    const text = answerPartText({
      type: "answer",
      questionId: "q-3",
      question: "怎么办？",
      optionIds: [],
      labels: [],
      text: "先只做底板",
    });
    expect(text).toContain("用户选择：（未选择预设选项）");
    expect(text).toContain("用户补充：先只做底板");
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
