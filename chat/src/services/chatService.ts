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
    /image-blast|uncover/,
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
    /*
      英文语序（2026-10 实测漏判：判定为 false 时工具集里根本没有 analyze-reference，
      agent 只能自己编 slug 去调 mode=edit，批量 404）。中文那几条模式套不到英文语序上：
      英文把"提取什么"放在动词之后、"从哪张图"挪到后半句，于是
      "Extract all the furniture from this image and generate 3D models" 整句落空。
      这两条分别覆盖**先提取后建模**与**先建模再交代来源**两种语序。
      负例必须继续为假（"Can you make this 3D model look better?"、
      "Is this 3D model from this photo correct?"）：所以第二条同时要求创造类动词与来源侧
      落到图/物体上——光有"3D 模型 + 图"这两个词不算意图，那正是普通提问的样子。
    */
    /(extract|pull|isolate|separate|split|identify).{0,48}(objects?|items?|furniture|assets?|models?|pieces?)/,
    /(generate|make|create|turn|convert|produce|build).{0,40}(3d|three-d|三维|models?|assets?).{0,40}\b(from|of|in|into|using)\b.{0,24}(image|photo|picture|objects?|furniture|items?|scene)/,
  ].some((pattern) => pattern.test(normalized));
}

/**
 * 本条消息是否在**明确要求直接用它附带的原图**当参考图（不要生成新参考图）。
 *
 * 为什么要在服务端判一次、而不是只写在提示词里：2026-10-05 用户连着两轮说了「不要
 * 生成参考图，直接用这张图来生成」「你不能直接拿我给你的图片来生成吗」，Agent 两轮都
 * 用自己的判断把原图换成了"更干净的参考图"——它认为那张照片斜侧视、带草地和天空、
 * 背面没有信息，所以先隔离一张更稳妥。**判断本身没错，错在它不是决策者**：用户已经
 * 表态用哪张图，这就不是技术选择而是产品选择，只有他能改。at 提示词层面约束不了这种
 * "为你好"的覆盖，所以在决策点由服务端把话说明白（与 `referenceAnalysisAllowed`
 * 同一套做法：能确定性判断的东西不要交给模型猜）。
 *
 * 只在"本条消息恰好带一张图"时才被调用方使用——多张图时该问用户用哪张，不能替他挑。
 */
export function hasExplicitUploadAsReferenceIntent(message: ChatMessage): boolean {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  // 把整张图拆成完整场景/世界是另一条路（analyze-reference），不是"把原图登记成
  // 单物体参考图"。用户同时说了这两件事时按场景走，别在这条路上误导模型。
  if (/(完整|一键|整个).{0,12}(场景|世界)|(场景|世界).{0,12}(生成|重建|还原)/.test(normalized)) {
    return false;
  }

  /** 直接否掉"生成参考图"这件事——最强也最不容易误判的一种说法。 */
  if (
    /(不要|不用|不需要|无需|别再|不用再).{0,10}(生成|出|做|画).{0,10}(参考图|参考图片|新图)/.test(
      normalized,
    ) ||
    /(don'?t|do not|no need to|without|skip|avoid).{0,24}(generat|creat|mak|draw)\w*.{0,24}(reference )?(image|picture|photo)/.test(
      normalized,
    )
  ) {
    return true;
  }
  /** "直接用/拿我这张图"这类指代 + 一个生成类动词，两者同时具备才算。 */
  const pointsAtOwnImage =
    /(直接|就).{0,4}(用|拿|喂给?|使?用).{0,6}(我|这|那)?(张|个|份)?(上传的?)?(原图|图片|照片|图)/.test(
      normalized,
    ) ||
    /(我|你)给(我|你)的?(原图|图片|照片|图)/.test(normalized) ||
    /(上传的|本条的?|附带的?)(原图|图片|照片)/.test(normalized) ||
    // "我要提交的参考图是这张"：点名了是哪张，同样是明确表态
    /参考图.{0,8}(是|用|要).{0,6}(这|那)张/.test(normalized) ||
    /*
      英文语序（与 hasExplicitReferenceAnalysisIntent 同一个教训：中文那几条模式套不到
      英文上，而英文把"用哪张图"放在动词之后）。要求"指代图"与"生成类动词"同时具备，
      所以 "Can you make this 3D model look better?" 这类普通提问仍然为假。
    */
    /(use|using|submit|feed|take|pass|send).{0,24}(my|this|that|the|uploaded|attached|original).{0,16}(original )?(image|photo|picture)/.test(
      normalized,
    ) ||
    /(my|the|this|that) (uploaded|attached|original) (image|photo|picture)/.test(normalized);
  const wantsGeneration =
    /(生成|做成|创建|建模|模型|提交|转成|转换成|3d|三维)/.test(normalized) ||
    /(3d|three-d|model|models|mesh|generat\w*|submit|convert|turn)/.test(normalized);
  return pointsAtOwnImage && wantsGeneration;
}

/**
 * "用户要求直接用附带的原图"这条上下文里要说的话。
 *
 * 抽成纯函数是为了能单独测：这段话的作用是**压住模型自己的档位判断**，措辞一旦被
 * 改软（例如变成"建议优先使用原图"），用户就会第三次遇到同一件事——他说了用哪张图，
 * Agent 却"为你好"地换成先出一张更干净的。
 */
export function uploadAsReferenceContextLine(
  imagePath: string,
  threeDProvider: string | undefined,
): string {
  return (
    `**用户明确要求直接把它附带的那张原图当参考图**（${imagePath}）。` +
    "用户已经表态选哪张图，**这不是技术选择而是产品选择**：用 attach-source-image " +
    "把它登记为参考图即可（免费、本地、不需要同意），**不要**因为构图、背景太杂、" +
    "机位斜侧视、背面没有信息之类的原因换成 generate-reference-images 先生成一张。" +
    "这些风险写进 ask-user 卡片的 details 让他知情并拍板，**但不要替他改主意**。" +
    (threeDProvider === "hi3d-volc"
      ? "例外：他选的渠道是数美 Hi3D，它只吃 Seedream 产物的公网 URL，原图喂不进去；" +
        "如实说明并请他要么换渠道、要么同意先出一张。"
      : "")
  );
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
 * 服务端不保存提问状态，问题原文与选项文字都随答案带回来，这里只负责拼装；
 * 不写成裸文本是为了让模型明确知道这是对某个提问的回答，而不是用户新提的指令。
 */
export function answerContextText(answer: AskUserAnswer): string {
  const chosen =
    answer.labels.length > 0 ? answer.labels.join("、") : "（未选择预设选项）";
  return [
    `【对提问的回答】问题：「${answer.question}」（${answer.questionId}）`,
    `用户选择：${chosen}`,
    ...(answer.text ? [`用户补充：${answer.text}`] : []),
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
  const pendingTargets = await listPendingGenerationTargets(
    storage,
    request.projectSlug,
    request.sessionStartedAt,
  );
  const currentPlan = request.plan ?? state.plan;
  const threeDSelection = threeDModelFor(request.threeDModel);
  /*
    只在"本条消息恰好带一张图"时判：多张图时该由用户点名用哪张，不能替他挑一张
    （attach-source-image 自己也会拒绝多图）。续跑轮没有新的用户消息，
    `currentImagePaths` 本来就为空，这里自然不触发。
  */
  const uploadedAsReference =
    currentImagePaths.length === 1 &&
    latestUserMessage !== undefined &&
    hasExplicitUploadAsReferenceIntent(latestUserMessage);
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
      `待生成对象（尚未成为正式资产，只列**本会话**登记的目标）：${
        pendingTargets.length > 0
          ? pendingTargets
              .map(
                (target) =>
                  `${target.name}(${target.slug}，参考图${target.sourceImages?.length ?? 0}张)`,
              )
              .join("、")
          : "无"
      }。`,
      /*
        参考图的复用纪律必须写在这里：项目 source/ 目录里可能还留着上一轮会话生成的
        参考图，Agent 在资产名录里看不到它们的"归属"，只看到"有张图"。旧措辞是
        「已有参考图的待生成对象可直接用同一 slug 调 start-3d-batch，不要重新生成」，
        那等于教它拿旧图开工（用户报的正是这条）。现在改成分两步：新对象自己重新生成，
        要复用先问。
      */
      pendingTargets.length > 0
        ? "这些是本次会话刚确认的目标：可以直接用同一 slug 调 start-3d-batch；" +
          "它们的参考图就是本轮的产物，不必重新生成。"
        : "本次会话还没有登记过生成目标。",
      "**参考图不许跨会话自动复用**：项目 source/ 里可能还留着更早会话生成的参考图，" +
        "它们不是本轮产物。要拿其中任何一张去生成/编辑，必须先用 ask-user 卡片向用户" +
        "确认（写清是哪张图、为什么合适、以及接下来要做的付费操作），得到同意后再把该" +
        "路径显式传给工具；用户没同意就不要用。新对象请用 generate-reference-images" +
        "重新生成参考图，不要拿旧图顶替。服务端也会拦：靠兜底（没有显式传图）取到旧图时" +
        "会直接报错并把可选清单给你。",
      ...(currentPlan ? [planContextText(currentPlan)] : []),
      "若用户消息带有“本条消息明确选中的资产”，它们是该条指令的主要目标，代词优先指向它们；" +
        "未带资产附件时，再根据完整资产名录和对话判断，无法唯一确定才向用户确认。",
      ...(uploadedAsReference
        ? [
            uploadAsReferenceContextLine(
              currentImagePaths[0]!,
              threeDSelection?.provider,
            ),
          ]
        : []),
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
    ...(request.answer ? [toAnswerMessage(request.answer)] : []),
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
