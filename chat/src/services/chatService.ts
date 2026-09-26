import { ChatServiceError, toErrorMessage } from "../common/errors";
import {
  LogicalPathSchema,
  ProjectPlanSchema,
  type ProjectPlan,
} from "../dto/library";
import type {
  AskUserQuestion,
  ChatContentPart,
  ChatMessage,
  ChatResume,
  ChatStreamRequest,
} from "../dto/chat";
import { createCreatorAgent } from "../mastra/agents/creator";
import { threeDModelFor } from "../models/threeD";
import { getProjectState } from "../mastra/tools/projectTools";
import { askUserQuestionFromToolResult } from "../mastra/tools/askUser";
import {
  getAssetStorage,
  readAsDataUri,
  readJson,
  type AssetStorage,
} from "./assetStorage";
import { readCandidates } from "./candidateRegistry";
import { buildRequestContext } from "./workflowRuns";

/** Mastra 消息（贴 AI SDK ModelMessage 判别联合：只有 user 能带图片部件） */
type AgentContentPart = { type: "text"; text: string } | { type: "image"; image: string };
type AgentMessage =
  | { role: "system"; content: string }
  | { role: "assistant"; content: string }
  | { role: "user"; content: string | AgentContentPart[] };

/** 让中断后的下一轮仍能看到已生成参考图、但尚未发布模型的目标。 */
export async function listPendingGenerationTargets(
  storage: AssetStorage,
  projectSlug: string,
) {
  return (await readCandidates(storage, projectSlug)).objects;
}

/**
 * 参考图工作流会建立资产身份并引出后续生成，不能仅凭“消息里有图”猜测用户意图。
 * 这里只接受明确的参考图/资产提取措辞；普通看图、截图排错和设计讨论保持 false，
 * 由外层多模态模型直接回答。
 */
export function hasExplicitReferenceAnalysisIntent(message: ChatMessage): boolean {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;

  return [
    /analyze-reference/,
    /run-one-shot|one-shot-scene|image-blast|uncover/,
    /(完整|一键|自动).{0,12}(场景|世界).{0,16}(生成|建模|3d|三维)/,
    /(一键|自动).{0,12}(生成|制作).{0,12}(完整)?(场景|世界)/,
    /(生成|制作|创建|做成).{0,12}完整.{0,12}(场景|世界)/,
    /参考图.{0,24}(分析|拆分|拆解|提取|识别|生成|建模|3d|三维)/,
    /(分析|拆分|拆解|提取|识别).{0,24}参考图/,
    /(提取|拆分|拆解|识别).{0,24}(资产|物体|对象|模型)/,
    /(家具|物件|物品|物体|对象).{0,24}(拆出来|拆分|拆解|提取|隔离).{0,24}(参考图|单图|图片)/,
    /(拆出来|单独拆|分别拆).{0,24}(参考图|单图)/,
    /(把|将).{0,20}(图|图片|照片).{0,30}(生成|制作|创建|做成|转成|转换成).{0,16}(3d|三维|模型|资产)/,
    /(图中|图片里|照片里|里面|其中).{0,30}(物体|对象|资产).{0,30}(生成|制作|建模|模型)/,
    /(extract|split|identify).{0,32}(asset|object|model).{0,32}(image|photo)/,
    /(image|photo).{0,32}(into|to|as).{0,16}(3d|assets?|models?)/,
  ].some((pattern) => pattern.test(normalized));
}

/** 对话流增量：文本或工具调用透明度事件（toolCallId+args 供 app 侧协作工具消费） */
export type ChatDelta =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      toolCallId?: string;
      args?: Record<string, unknown>;
    }
  | {
      type: "tool-result";
      name: string;
      toolCallId?: string;
      /** 生成工具刚落盘的图片，供工作台立即展示；只传库内逻辑路径。 */
      images?: string[];
      /** 后台任务工具刚创建的任务 id，供工作台精确轮询并在结束后唤醒 Agent。 */
      taskIds?: string[];
      /** update-plan 的完整落盘结果，供当前会话立即持久化。 */
      plan?: ProjectPlan;
      /** ask-user 的提问；发出后本轮即中止，等待用户点选或输入。 */
      question?: AskUserQuestion;
    }
  | { type: "tool-error"; name: string; toolCallId?: string; message?: string };

/** Mastra 不同工具失败事件的错误字段形状不一致，统一提取一条可展示消息。 */
export function toolErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value instanceof Error) return value.message.trim() || value.name;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "errorText", "cause", "reason", "result"]) {
    const message = toolErrorMessage(record[key]);
    if (message) return message;
  }
  return undefined;
}

/**
 * 工具完整结果还要回给 LLM，但不应原样塞进 SSE（里面可能有供应商元数据或大对象）。
 * 工作台只需要同步图片工具的落盘路径；统一入口的三种模式均返回 images。
 */
export function imagePathsFromToolResult(
  toolName: string,
  result: unknown,
): string[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  const candidates =
    toolName === "generate-reference-images" || toolName === "generateReferenceImagesTool" ||
      toolName === "generate-clean-plate" || toolName === "generateCleanPlateTool"
      ? record.images
      : toolName === "generate-skybox" || toolName === "generateSkyboxTool"
        ? [record.image]
      : toolName === "edit-reference-image" || toolName === "editReferenceImageTool"
        ? [record.image]
        : undefined;
  if (!Array.isArray(candidates)) return undefined;

  const paths = [
    ...new Set(
      candidates.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && LogicalPathSchema.safeParse(candidate).success,
      ),
    ),
  ];
  return paths.length > 0 ? paths : undefined;
}

/** 工具与旧 Mastra Workflow 兼容返回形状中提取后台任务 id。 */
export function taskIdsFromToolResult(result: unknown): string[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const outer = result as { result?: unknown; task?: unknown; tasks?: unknown };
  const record = outer.result && typeof outer.result === "object"
    ? outer.result as { task?: unknown; tasks?: unknown }
    : outer;
  const candidates = Array.isArray(record.tasks)
    ? record.tasks
    : record.task
      ? [record.task]
      : [];
  const ids = [
    ...new Set(
      candidates.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const id = (candidate as { id?: unknown }).id;
        return typeof id === "string" && id.length > 0 ? [id] : [];
      }),
    ),
  ];
  return ids.length > 0 ? ids : undefined;
}

/**
 * 计划注入 agent 上下文的文本。标题必须出现在这里：模型读不到 plan.json，
 * 只有上下文给出当前标题，"普通进度更新不得改标题"才是它可遵守的约束，
 * 而不是一条只能靠撞 409 才发现的隐藏规则。
 */
export function planContextText(plan: ProjectPlan): string {
  return [
    `当前会话执行计划：${plan.title ? `「${plan.title}」` : "（无标题）"}，v${plan.revision}。` +
      "继续执行时 update-plan 只传已有步骤 id 与新 status：计划标题、步骤 id 和步骤内容都保持不变；" +
      "只有用户改变目标或事实证明原路线不可行时，才用 mode=replan 并填写 reason。",
    ...plan.steps.map((step) => `- [${step.status}] ${step.id}: ${step.content}`),
  ].join("\n");
}

/** 只接受 update-plan 返回且通过契约校验的完整计划。 */
export function planFromToolResult(
  toolName: string,
  result: unknown,
): ProjectPlan | undefined {
  if (toolName !== "update-plan" && toolName !== "updatePlanTool") return undefined;
  if (!result || typeof result !== "object") return undefined;
  const parsed = ProjectPlanSchema.safeParse((result as { plan?: unknown }).plan);
  return parsed.success ? parsed.data : undefined;
}

/**
 * ask-user 卡片的点选结果 → 给模型看的文本。
 * 服务端不保存提问状态，问题原文与选项文字都随消息带回来，这里只负责拼装；
 * 不写成裸文本是为了让模型明确知道这是对某个提问的回答，而不是用户新提的指令。
 */
export function answerPartText(
  part: Extract<ChatContentPart, { type: "answer" }>,
): string {
  const chosen =
    part.labels.length > 0 ? part.labels.join("、") : "（未选择预设选项）";
  return [
    `【对提问的回答】问题：「${part.question}」（${part.questionId}）`,
    `用户选择：${chosen}`,
    ...(part.text ? [`用户补充：${part.text}`] : []),
  ].join("\n");
}

/**
 * dto 消息 → Mastra 消息：图片部件按逻辑路径从资产库读出内联为 data URI
 * （OpenAI 兼容协议只认用户消息里的图）。
 */
export async function toAgentMessages(
  storage: AssetStorage,
  messages: ChatMessage[],
  assetNamesBySlug: ReadonlyMap<string, string> = new Map(),
): Promise<AgentMessage[]> {
  const result: AgentMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role !== "user") {
      // 非 user 角色协议上装不了图/资产附件：只保留文本部件
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      result.push({ role: message.role, content: text });
      continue;
    }
    const parts: AgentContentPart[] = [];
    const attachedSlugs = [
      ...new Set(
        message.content
          .filter((part) => part.type === "asset")
          .map((part) => part.assetSlug),
      ),
    ];
    if (attachedSlugs.length > 0) {
      const targets = attachedSlugs
        .map((slug) => {
          const name = assetNamesBySlug.get(slug);
          return name ? `${name}(${slug})` : `已删除或不存在的资产(${slug})`;
        })
        .join("、");
      parts.push({
        type: "text",
        text:
          `【本条消息明确选中的资产】${targets}。` +
          "这些资产是本条指令的主要目标；“它 / 这个模型 / 这些模型”等指代优先落到这里。",
      });
    }
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "answer") {
        parts.push({ type: "text", text: answerPartText(part) });
      } else if (part.type === "image") {
        parts.push({ type: "image", image: await readAsDataUri(storage, part.path) });
      }
    }
    result.push({ role: "user", content: parts });
  }
  return result;
}

/**
 * 续跑消息 → Mastra 消息：Agent 自发续跑时本轮要看的产物（自检截图等）。
 *
 * 协议上只能借用 user 角色装图，但语义上它不是用户输入：调用方把它单独放在
 * 请求的 `resume` 字段里，服务端只在本次请求把它接在历史末尾，既不会被工作台
 * 写进会话记录，也不会在后续轮次里被重复内联回传。
 */
export async function toResumeMessage(
  storage: AssetStorage,
  resume: ChatResume,
): Promise<AgentMessage> {
  const parts: AgentContentPart[] = [{ type: "text", text: resume.text }];
  for (const path of resume.images ?? []) {
    parts.push({ type: "image", image: await readAsDataUri(storage, path) });
  }
  return { role: "user", content: parts };
}

/** 把对话请求中的临时配置完整注入 Agent 工具上下文。 */
export function buildChatRequestContext(
  request: ChatStreamRequest,
  currentImagePaths: string[],
  referenceAnalysisAllowed: boolean,
) {
  return buildRequestContext({
    projectSlug: request.projectSlug,
    llm: request.llm,
    currentImagePaths,
    referenceAnalysisAllowed,
    worldLabsApiKey: request.worldLabsApiKey,
    tripo3dApiKey: request.tripo3dApiKey,
    hunyuanApiKey: request.hunyuanApiKey,
    seed3dApiKey: request.seed3dApiKey,
    volcengineApiKey: request.volcengineApiKey,
    threeDModel: request.threeDModel,
    imageGenerateModel: request.imageGenerateModel,
  });
}

/**
 * 驱动 creator agent，返回增量流（文本 + 工具调用可见性）。
 * 走 fullStream 而非 textStream：上游 LLM 报错（如无效 key）只出现在
 * fullStream 的 error chunk 里，textStream 会静默结束。
 */
export async function* streamChat(
  request: ChatStreamRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<ChatDelta> {
  const latestUserMessage = request.messages.findLast(
    (message) => message.role === "user",
  );
  /*
    续跑轮没有新的用户输入：它看的是 Agent 自己的产物，不是用户附的参考图。
    这里必须把两条请求级判断都按"没有用户消息"处理，否则上一轮用户附的参考图
    会被重新认成"本条消息明确附带"，把 analyze-reference 重新放回工具集。
  */
  const currentImagePaths =
    !request.resume && latestUserMessage && typeof latestUserMessage.content !== "string"
      ? latestUserMessage.content
          .filter((part) => part.type === "image")
          .map((part) => part.path)
      : [];
  const referenceAnalysisAllowed = Boolean(
    !request.resume &&
      latestUserMessage &&
      currentImagePaths.length === 1 &&
      hasExplicitReferenceAnalysisIntent(latestUserMessage),
  );
  const agent = createCreatorAgent(request.llm, {
    enableAnalyzeReference: referenceAnalysisAllowed,
  });
  const storage = getAssetStorage();
  const state = await getProjectState(storage, request.projectSlug);
  const pendingTargets = await listPendingGenerationTargets(storage, request.projectSlug);
  const currentPlan = request.plan ?? state.plan;
  const threeDSelection = threeDModelFor(request.threeDModel);
  const assetNamesBySlug = new Map(
    state.assets.map((asset) => [
      asset.slug,
      asset.identity?.name ?? asset.slug,
    ]),
  );
  const projectContext: AgentMessage = {
    role: "system",
    content: [
      `当前项目：${state.project.name}（${state.project.slug}）。`,
      "本次对话与所有工具已经由服务端锁定到当前项目；不要创建、切换或枚举其他项目。",
      `源图：${state.sources.length > 0 ? state.sources.join("、") : "无"}。`,
      `资产（按创建时间新→旧排列）：${
        state.assets.length > 0
          ? [...state.assets]
              .sort((a, b) =>
                (b.identity?.createdAt ?? "").localeCompare(a.identity?.createdAt ?? ""),
              )
              .map((asset) => `${asset.identity?.name ?? asset.slug}(${asset.slug})`)
              .join("、")
          : "无"
      }。`,
      `待生成对象（尚未成为正式资产）：${
        pendingTargets.length > 0
          ? pendingTargets
              .map(
                (target) =>
                  `${target.name}(${target.slug}，参考图${target.sourceImages?.length ?? 0}张)`,
              )
              .join("、")
          : "无"
      }。已有参考图的待生成对象可直接用同一 slug 调 start-3d-batch，不要重新生成或分析图片。`,
      ...(currentPlan ? [planContextText(currentPlan)] : []),
      "若用户消息带有“本条消息明确选中的资产”，它们是该条指令的主要目标，代词优先指向它们；" +
        "未带资产附件时，再根据完整资产名录和对话判断，无法唯一确定才向用户确认。",
      ...(threeDSelection
        ? [
            `用户在界面上显式选择了 3D 生成模型：${threeDSelection.label}（模型 ID ` +
              `${threeDSelection.model}，渠道 ${threeDSelection.provider}）。start-3d-batch 的渠道与模型 ` +
              "ID 由服务端按这个选择钉住，你不需要在 provider 参数上另作选择；向用户说明付费计划时按这个模型报。" +
              (threeDSelection.provider === "seed3d-direct"
                ? ""
                : "注意 SceneJob 的单物体模型当前固定用 Seed3D，与这个选择无关，涉及完整场景时要先说明。"),
          ]
        : []),
      ...(request.imageGenerateModel
        ? [
            `用户在界面上显式选择了图片生成模型：${request.imageGenerateModel}。调用 ` +
              "generate-reference-images 的 mode=generate 时，model 参数优先使用这个选择；" +
              "mode=edit 也使用这个选择。",
          ]
        : []),
    ].join("\n"),
  };
  const messages = [
    projectContext,
    ...(await toAgentMessages(storage, request.messages, assetNamesBySlug)),
    ...(request.resume ? [await toResumeMessage(storage, request.resume)] : []),
  ];
  // 当前项目与供应商 key 注入工具上下文（都只活在请求生命周期）
  const output = await agent.stream(messages, {
    abortSignal,
    requestContext: buildChatRequestContext(
      request,
      currentImagePaths,
      referenceAnalysisAllowed,
    ),
  });

  for await (const chunk of output.fullStream) {
    if (chunk.type === "text-delta") {
      yield { type: "text", text: chunk.payload.text };
    } else if (chunk.type === "tool-call") {
      const payload = chunk.payload as {
        toolName?: string;
        toolCallId?: string;
        args?: Record<string, unknown>;
      };
      if (payload.toolName) {
        yield {
          type: "tool",
          name: payload.toolName,
          toolCallId: payload.toolCallId,
          args: payload.args,
        };
      }
    } else if (chunk.type === "tool-result") {
      const payload = chunk.payload as {
        toolName?: string;
        toolCallId?: string;
        isError?: boolean;
        result?: unknown;
      };
      if (payload.toolName) {
        const taskIds = taskIdsFromToolResult(payload.result);
        const plan = planFromToolResult(payload.toolName, payload.result);
        const question = payload.isError
          ? undefined
          : askUserQuestionFromToolResult(payload.result);
        yield {
          type: payload.isError ? "tool-error" : "tool-result",
          name: payload.toolName,
          toolCallId: payload.toolCallId,
          ...(payload.isError
            ? { message: toolErrorMessage(payload.result) }
            : {
                images: imagePathsFromToolResult(payload.toolName, payload.result),
                taskIds,
                plan,
                question,
              }),
        };
        /*
          ask-user 提问后必须立刻停住这一轮：模型完全可能在同一条回复里把「问用户」
          和付费工具一起调出来，光靠提示词纪律挡不住。

          这里只结束生成器，真正的中止交给消费方（routes/chat.ts）在问题写进 SSE
          之后触发：在生成器内部直接 abort 会让 for-await 的 return() 撞上一个已经
          出错的流，把一次正常提问变成一条报错。
        */
        if (question) return;
      }
    } else if (chunk.type === "tool-error") {
      const payload = chunk.payload as {
        toolName?: string;
        toolCallId?: string;
        error?: unknown;
      };
      if (payload.toolName) {
        yield {
          type: "tool-error",
          name: payload.toolName,
          toolCallId: payload.toolCallId,
          message: toolErrorMessage(payload.error ?? payload),
        };
      }
    } else if (chunk.type === "error") {
      throw new ChatServiceError(
        `上游 LLM 调用失败：${toErrorMessage(chunk.payload.error)}`,
        502,
        "upstream_llm_error",
      );
    }
  }
}
