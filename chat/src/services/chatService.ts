import { ChatServiceError, toErrorMessage } from "../common/errors";
import {
  LogicalPathSchema,
  ProjectPlanSchema,
  type ProjectPlan,
} from "../dto/library";
import type {
  AskUserAnswer,
  AskUserQuestion,
  ChatMessage,
  ChatResume,
  ChatStreamRequest,
} from "../dto/chat";
import { createCreatorAgent } from "../mastra/agents/creator";
import { generationModelFor } from "../models/threeD";
import { getProjectState } from "../mastra/tools/projectTools";
import { askUserQuestionFromToolResult } from "../mastra/tools/askUser";
import {
  getAssetStorage,
  readAsDataUri,
  readJson,
  type AssetStorage,
} from "./assetStorage";
import { readCandidates } from "./candidateRegistry";
import { replyLanguageForMessages } from "./replyLanguage";
import { buildRequestContext } from "./workflowRuns";

/** Mastra 消息（贴 AI SDK ModelMessage 判别联合：只有 user 能带图片部件） */
type AgentContentPart = { type: "text"; text: string } | { type: "image"; image: string };
type AgentMessage =
  | { role: "system"; content: string }
  | { role: "assistant"; content: string }
  | { role: "user"; content: string | AgentContentPart[] };

/**
 * 让中断后的下一轮仍能看到已生成参考图、但尚未发布模型的目标。
 *
 * **只给本会话登记的目标**。`candidates.json` 是项目级单例，新建会话时上一轮留下的
 * 未完成对象会一并被读出来；把它们喂给模型，模型就会拿着上一轮的参考图直接开工，
 * 而用户要的是"新会话从零开始，想复用先问过我"。判据是登记时间与会话开始时间
 * （客户端随请求带来；缺省表示旧客户端，不做本轮判断）。
 */
export async function listPendingGenerationTargets(
  storage: AssetStorage,
  projectSlug: string,
  sessionStartedAt?: number,
) {
  const objects = (await readCandidates(storage, projectSlug)).objects;
  if (sessionStartedAt === undefined) return objects;
  return objects.filter((object) => {
    const registeredAt = object.createdAt ?? "";
    const registeredMs = Date.parse(registeredAt);
    return Number.isFinite(registeredMs) && registeredMs >= sessionStartedAt;
  });
}

/*
  这里曾经有一个 `hasExplicitReferenceAnalysisIntent`：拿正则去猜"这句话是不是在要
  参考图资产提取"，并**用它决定 analyze-reference 是否出现在工具表里**。2026-10-15
  的事故证明这个形状本身是错的，所以整块删掉了：

  - 它是**隐藏前置条件**：模型看不到自己这一轮算不算"明确要求"，只能靠措辞去撞正则。
    项目名就叫「将这个场景生成出来。每一个家具都是单独的」，用户原样打出来判定为 false。
  - 判定为 false 时工具表里没有 analyze-reference，而系统提示词无条件叫模型调它 →
    浏览器本地版抛 `Unknown tool`，模型再退而调常驻的 start-scene-job → 404 且文案
    还叫它去调那个不存在的工具。重试永远一样：工具表是按措辞算的。
  - 它维护的是**措辞**而不是**边界**：真正的边界是"这张图是不是用户在本场对话里带来的"
    （`conversationImagePaths`，只走客户端带来的本会话历史，绝不扫描 source/），
    以及"付费前必须有用户点过的确认卡"。措辞猜错的代价（多一次免费分析 + 一张确认卡）
    远小于把整条完整场景通路卡死的代价。

  所以现在的口径：**工具常驻，判断留在提示词与工具描述里（模型看得见）**；
  参考图由"本条消息附带的图 → 本场对话里用户附过的图"解析（见 requestContext.ts 的
  referenceImagesInPlay），分析结果停在对象确认站，付费生成仍然要用户点卡同意。
*/

/**
 * 本轮请求里**整场对话**中用户附带的图片，按出现顺序去重。
 *
 * 为什么不能只看最新一条消息（2026-10-05 用户第三次踩到的坑）：他那两轮是
 * 「带图说：直接这张图提交」→「不带图说：我不要生成参考图，直接用**我发你的这张**来搞」。
 * 第二条消息本身没有图，于是只认"本条消息"的工具拿到空数组，报"本条消息没有附带图片"，
 * 模型只能自己猜路径（实测它依次试了字符串 `"null"`、裸文件名 `0-xxx.png`、
 * `source/0-xxx.png`，全错）。**用户说的"我发你的那张"指的是这场对话里的图，
 * 不是"这一条消息里的图"** —— 判据必须跟着他的指代走。
 *
 * 只看 `request.messages`（客户端带来的本会话历史），所以不会把上一场会话的图算进来。
 * 2026-10-15 起它同时是"参考图分析该用哪张图"的回退来源（见 requestContext.ts 的
 * referenceImagesInPlay）：同一条指代纪律，工具与工具表给的是同一个答案。
 */
export function conversationImagePaths(messages: ChatMessage[]): string[] {
  const paths: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image" && !paths.includes(part.path)) paths.push(part.path);
    }
  }
  return paths;
}

/** 对话流增量：文本或工具调用透明度事件（toolCallId+args 供 app 侧协作工具消费） */
export type ChatDelta =
  | { type: "text"; text: string }
  /**
   * 推理模型的思维链增量。与 `text` 分开是刻意的：它不是回复正文，不写进消息
   * 内容、不回放给模型，只在等待期间给用户一个"正在思考"的可见进度。
   */
  | { type: "reasoning"; text: string }
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
    `Current session plan: ${plan.title ? `"${plan.title}"` : "(untitled)"}, v${plan.revision}.` +
      "When continuing, pass only the existing step ids and the new status to update-plan: the plan title, step ids and step content all stay unchanged; " +
      "only when the user changes the goal or the evidence proves the original route infeasible, use mode=replan and fill in reason.",
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
 * 服务端不保存提问状态，问题原文与选项文字都随答案带回来，这里只负责拼装；
 * 不写成裸文本是为了让模型明确知道这是对某个提问的回答，而不是用户新提的指令。
 */
export function answerContextText(answer: AskUserAnswer): string {
  const chosen =
    answer.labels.length > 0 ? answer.labels.join(", ") : "(no preset option selected)";
  return [
    `[Answer to question] Question: "${answer.question}" (${answer.questionId})`,
    `User selection: ${chosen}`,
    ...(answer.text ? [`User note: ${answer.text}`] : []),
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
          return name ? `${name}(${slug})` : `deleted or missing asset(${slug})`;
        })
        .join(", ");
      parts.push({
        type: "text",
        text:
          `[Assets explicitly selected in this message] ${targets}. ` +
          "These assets are the primary targets of this instruction; references such as \"it / this model / these models\" resolve here first.",
      });
    }
    for (const part of message.content) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
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

/**
 * 卡片回答 → 本轮上下文。
 *
 * 和 resume 同款：协议上只能借 user 角色，但语义上它不是用户发言——用户点的是
 * 卡片。工作台不把它写进会话记录，界面上也只在卡片里显示"已选择：X"，所以它既
 * 不会在历史里多出一条用户气泡，也不会在后续每一轮被重复回放。
 */
export function toAnswerMessage(answer: AskUserAnswer): AgentMessage {
  return { role: "user", content: answerContextText(answer) };
}

/**
 * 把服务端判定的回复语言指令追加到**本轮最后一条 user 消息**末尾。
 *
 * 位置是刻意的：固定指令在最前、中间隔着整段中文项目上下文与中文工具返回值，一条写在
 * 那里的"跟随用户语言"压不住这些信号（2026-10-06 用户报"我说英文它回中文"，会话库里
 * 英文开场得到整条中文回复的样本就在 `s-p-mupq6eua-mupq6eum`）。判断放在模型最后读到的
 * 那条消息末尾，才和"这一轮该用什么语言"绑定在一起。
 *
 * 判定只看 `source`（客户端带来的会话历史，用户真实发言只在这里）。工作台续跑轮虽然也
 * 借 user 角色，但不是用户发言，`replyLanguageForMessages` 会跳过它们。
 */
export function withReplyLanguageDirective(
  messages: AgentMessage[],
  source: readonly ChatMessage[],
): AgentMessage[] {
  const language = replyLanguageForMessages(source);
  if (!language) return messages;
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (lastUserIndex < 0) return messages;
  const next = [...messages];
  const target = next[lastUserIndex]!;
  if (target.role !== "user") return messages;
  next[lastUserIndex] = {
    role: "user",
    content:
      typeof target.content === "string"
        ? `${target.content}\n\n${language.directive}`
        : [...target.content, { type: "text", text: language.directive }],
  };
  return next;
}

/** 把对话请求中的临时配置完整注入 Agent 工具上下文。 */
export function buildChatRequestContext(
  request: ChatStreamRequest,
  currentImagePaths: string[],
  conversationImages: string[] = [],
) {
  return buildRequestContext({
    projectSlug: request.projectSlug,
    llm: request.llm,
    currentImagePaths,
    conversationImagePaths: conversationImages,
    worldLabsApiKey: request.worldLabsApiKey,
    tripo3dApiKey: request.tripo3dApiKey,
    hunyuanApiKey: request.hunyuanApiKey,
    seed3dApiKey: request.seed3dApiKey,
    volcengineApiKey: request.volcengineApiKey,
    threeDModel: request.threeDModel,
    imageGenerateModel: request.imageGenerateModel,
    sessionStartedAt: request.sessionStartedAt,
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
    续跑轮没有新的用户输入，它看到的是 Agent 自己的产物；`resume` 里的图不算用户附图。
    注意这里只影响"本条消息附带了什么"，**不再影响工具表**：工具表只由进程配置决定
    （见 creator.ts 的模块注释），所以措辞与图片判不出所以然时，模型仍然看得见工具。
  */
  const currentImagePaths =
    !request.resume && latestUserMessage && typeof latestUserMessage.content !== "string"
      ? latestUserMessage.content
          .filter((part) => part.type === "image")
          .map((part) => part.path)
      : [];
  const agent = createCreatorAgent(request.llm);
  const storage = getAssetStorage();
  const state = await getProjectState(storage, request.projectSlug);
  const pendingTargets = await listPendingGenerationTargets(
    storage,
    request.projectSlug,
    request.sessionStartedAt,
  );
  const currentPlan = request.plan ?? state.plan;
  // 已下线的选择（旧客户端存的 Tripo）回退到当前默认模型，别让整个会话在构造上下文时失败
  const threeDSelection = request.threeDModel ? generationModelFor(request.threeDModel).entry : undefined;
  const conversationImages = conversationImagePaths(request.messages);
  const assetNamesBySlug = new Map(
    state.assets.map((asset) => [
      asset.slug,
      asset.identity?.name ?? asset.slug,
    ]),
  );
  const projectContext: AgentMessage = {
    role: "system",
    content: [
      `Current project: ${state.project.name} (${state.project.slug}).`,
      "This conversation and all tools are already locked to the current project by the server; do not create, switch to, or enumerate other projects.",
      `Source images: ${state.sources.length > 0 ? state.sources.join(", ") : "none"}.`,
      `Assets (sorted newest to oldest by creation time): ${
        state.assets.length > 0
          ? [...state.assets]
              .sort((a, b) =>
                (b.identity?.createdAt ?? "").localeCompare(a.identity?.createdAt ?? ""),
              )
              .map((asset) => `${asset.identity?.name ?? asset.slug}(${asset.slug})`)
              .join(", ")
          : "none"
      }.`,
      `Pending generation targets (not yet formal assets; only targets registered in **this session** are listed): ${
        pendingTargets.length > 0
          ? pendingTargets
              .map(
                (target) =>
                  `${target.name}(${target.slug}, reference images: ${target.sourceImages?.length ?? 0})`,
              )
              .join(", ")
          : "none"
      }.`,
      /*
        参考图的复用纪律必须写在这里：项目 source/ 目录里可能还留着上一轮会话生成的
        参考图，Agent 在资产名录里看不到它们的"归属"，只看到"有张图"。旧措辞是
        「已有参考图的待生成对象可直接用同一 slug 调 start-3d-batch，不要重新生成」，
        那等于教它拿旧图开工（用户报的正是这条）。现在改成分两步：新对象自己重新生成，
        要复用先问。
      */
      pendingTargets.length > 0
        ? "These are the targets just confirmed in this session: you can call start-3d-batch with the same slug directly; " +
          "their reference images are the output of this round, so there is no need to regenerate them."
        : "No generation targets have been registered in this session yet.",
      "**Reference images must not be reused automatically across sessions**: the project's source/ directory may still hold reference images generated by earlier sessions, " +
        "and they are not the output of this round. To use any of them for generation/editing, you must first ask the user " +
        "with an ask-user card (stating which image it is, why it fits, and which paid operation comes next); after approval, pass that " +
        "path to the tool explicitly; do not use it without the user's consent. For a new object, use generate-reference-images " +
        "to regenerate the reference image; do not substitute an old image. The server also blocks this: when the fallback (no image passed explicitly) picks up an old image, " +
        "it errors out directly and hands you the list of available choices.",
      ...(currentPlan ? [planContextText(currentPlan)] : []),
      "If a user message carries \"assets explicitly selected in this message\", they are the primary targets of that instruction and pronouns refer to them first; " +
        "when there is no asset attachment, judge from the complete asset list and the conversation, and only ask the user when you cannot determine it uniquely.",
      ...(conversationImages.length > 0
        ? [
            `Images the user attached in this conversation (in order of appearance): ${conversationImages.join(", ")}. ` +
              "When the user says \"the image I sent you\", they mean one of the images here; to designate one of them, pass the **full path " +
              "above** to the tool verbatim, do not build the `source/` prefix or a bare file name yourself, and do not pass the string " +
              '"null". Even if this message carries no image, you can still use this one (attach-source-image fetches it itself).',
          ]
        : []),
      ...(threeDSelection
        ? [
            `The user explicitly selected a 3D generation model in the UI: ${threeDSelection.label} (model ID ` +
              `${threeDSelection.model}, channel ${threeDSelection.provider}). The channel and model ` +
              "ID of start-3d-batch are pinned by the server to this selection, so you do not need to make a separate choice in the provider parameter; when explaining the paid plan to the user, report it for this model." +
              "Full-scene generation (start-scene-job) is temporarily unavailable while the model pipeline is migrated.",
          ]
        : []),
      ...(request.imageGenerateModel
        ? [
            `The user explicitly selected an image generation model in the UI: ${request.imageGenerateModel}. When calling ` +
              "generate-reference-images with mode=generate, the model parameter takes precedence as this selection; " +
              "mode=edit also uses this selection.",
          ]
        : []),
    ].join("\n"),
  };
  const messages = withReplyLanguageDirective(
    [
      projectContext,
      ...(await toAgentMessages(storage, request.messages, assetNamesBySlug)),
      ...(request.resume ? [await toResumeMessage(storage, request.resume)] : []),
      ...(request.answer ? [toAnswerMessage(request.answer)] : []),
    ],
    request.messages,
  );
  // 当前项目与供应商 key 注入工具上下文（都只活在请求生命周期）
  const output = await agent.stream(messages, {
    abortSignal,
    requestContext: buildChatRequestContext(
      request,
      currentImagePaths,
      conversationImages,
    ),
  });

  for await (const chunk of output.fullStream) {
    if (chunk.type === "text-delta") {
      yield { type: "text", text: chunk.payload.text };
    } else if (chunk.type === "reasoning-delta") {
      /*
        推理模型在正文之前先吐一段思维链。**它以前被整段丢弃**，症状是界面上
        长时间空白（实测一个稍难的提示要 85 秒才出第一个可见字符），用户以为卡死了。
        现在照原样转出去，由工作台渲染成"思考"块——不并入正文，因为它不是给用户
        看的答复，混进去会污染会话记录与后续上下文。
      */
      yield { type: "reasoning", text: chunk.payload.text };
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
        `Upstream LLM call failed: ${toErrorMessage(chunk.payload.error)}`,
        502,
        "upstream_llm_error",
      );
    }
  }
}
