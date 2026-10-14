import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { assetDir, projectInspectionsDir } from "../../common/libraryPaths";
import { SlugSchema } from "../../dto/library";
import { getAssetStorage, type AssetStorage } from "../../services/assetStorage";
import { getProjectState, latestAssetModel, requireProject } from "./projectTools";
import { requireCurrentProject } from "./requestContext";

/**
 * 视觉检查能力（免费）：agent 服务端没有渲染能力，截图由 app/ 完成——
 * `inspect` 只发信号（经 SSE tool 事件带 args 驱动 app 侧动作），检查图经
 * POST inspection 端点落盘后，由 app 以请求的 `resume` 字段交回，服务端把它接在
 * 下一轮上下文末尾（OpenAI 兼容协议的 tool 消息装不了图，这是唯一通道）。
 * 它不属于会话历史，也不在界面上冒充用户发言。
 *
 * 三种目标：
 *  - `asset`：一个资产自己的模型，默认拍 ISO/前/右/顶四视角（app 侧开预览小窗）；
 *  - `scene`：当前项目的整个场景，按**一个机位**拍一张（app 侧用主视口）；
 *  - `closeup`：某个资产**在场景里**的样子（app 侧把相机真的飞到它旁边再拍一张，之后飞回原机位）。
 *    `asset` 回答"这个模型本身长什么样"，`closeup` 回答"它摆在这儿合不合适"——要判贴合、
 *    悬空、穿模、与邻居的间距时用后者，它带着环境上下文。
 *
 * **什么时候调用**（这条是产品口径，提示词里同步写着）：只在用户明确要求检查、
 * 或用户对已经产出的东西提出疑问时调用；单模型生成完成不检查。唯一自动的一次是
 * 完整场景（SceneJob）全部节点成功后的整场景检查。
 */

/** 可拍的视角 id；与 app 的 `INSPECTION_VIEW_IDS` 同一份名单（两处都要改）。 */
export const INSPECTION_VIEW_IDS = [
  "iso",
  "front",
  "right",
  "top",
  "left",
  "back",
  "bottom",
] as const;

const INSPECTION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const SaveInspectionParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  /** 截图批次 id（app 侧用 toolCallId 或时间戳），限定字符集防路径注入 */
  inspectionId: z.string().regex(INSPECTION_ID_RE, "The inspection sheet id may only contain letters, digits, -, and _"),
  /** PNG 字节（2×2 四视角合成 sheet） */
  bytes: z.instanceof(Uint8Array),
});
export type SaveInspectionParams = z.infer<typeof SaveInspectionParamsSchema>;

/** 检查图落盘：assets/<asset>/inspections/<id>.png（QC 证据，随资产留档可溯源） */
export async function saveInspectionSheet(
  storage: AssetStorage,
  rawParams: SaveInspectionParams,
): Promise<{ path: string }> {
  const params = SaveInspectionParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  if (params.bytes.length === 0) {
    throw new ChatServiceError("The inspection sheet content is empty", 400, "empty_inspection");
  }
  const path = `${assetDir(params.projectSlug, params.assetSlug)}/inspections/${params.inspectionId}.png`;
  await storage.writeBytes(path, params.bytes);
  return { path };
}

export const SaveSceneInspectionParamsSchema = z.object({
  projectSlug: SlugSchema,
  inspectionId: z.string().regex(INSPECTION_ID_RE, "The inspection sheet id may only contain letters, digits, -, and _"),
  /** PNG 字节（单个机位的整场景图） */
  bytes: z.instanceof(Uint8Array),
});
export type SaveSceneInspectionParams = z.infer<typeof SaveSceneInspectionParamsSchema>;

/** 整场景检查图落盘：<project>/inspections/<id>.png（项目级 QC 证据，不挂到某个资产下） */
export async function saveSceneInspectionSheet(
  storage: AssetStorage,
  rawParams: SaveSceneInspectionParams,
): Promise<{ path: string }> {
  const params = SaveSceneInspectionParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  if (params.bytes.length === 0) {
    throw new ChatServiceError("The inspection sheet content is empty", 400, "empty_inspection");
  }
  const path = `${projectInspectionsDir(params.projectSlug)}/${params.inspectionId}.png`;
  await storage.writeBytes(path, params.bytes);
  return { path };
}

// ---------- Mastra tool 包装 ----------

/**
 * 入参刻意是一个**平铺对象**而不是判别联合：火山方舟的接入点要求
 * `tools.N.function.parameters` 顶层是 `type: object`，顶层 union 会序列化成
 * `anyOf` 并让整轮请求 400（creator.test.ts 里那条不变量守着这一点）。
 * 组合约束因此在 execute 里手工校验。
 */
export const InspectParamsSchema = z.object({
  target: z
    .enum(["asset", "scene", "closeup"])
    .describe(
      "asset = inspect a model belonging to one asset (look at its appearance on its own); scene = inspect the entire current project scene; closeup = look up close at how an asset sits in the scene",
    ),
  /** target=asset / closeup 时必填 */
  assetSlug: SlugSchema.optional(),
  /**
   * 要拍的视角 id。asset 省略 = ISO/前/右/顶四视角，也可以只要一个面（例如只看底面）；
   * scene 只取第一个作为机位，省略 = iso（斜 45° 俯瞰）。closeup 不用这一项。
   */
  views: z.array(z.enum(INSPECTION_VIEW_IDS)).min(1).optional(),
});
export type InspectParams = z.infer<typeof InspectParamsSchema>;

/** 服务端能给出的机位清单：agent 据此换机位，不用猜相机坐标。 */
const SCENE_VIEW_HINT =
  "Camera views you can ask for: iso (3/4 overview, default), front, right, top, left, back, bottom. If the image you get back is unusable (scene out of frame, blocked, too small to judge), call inspect again with another view — at most 3 camera changes — then report what you can and cannot see.";

/** 贴近检查没有可选机位：飞到哪里、从哪个角度拍都由摆放决定，重复调用只会得到同一张图。 */
const CLOSEUP_HINT =
  "The camera flies to the object and shoots from there, so calling inspect with target=\"closeup\" again gives the same framing — do not retry hoping for a different angle. If the object is not visible in the shot (still loading, hidden behind something else, or the camera is inside geometry), say so, or use target=\"asset\" to look at the model on its own.";

export const inspectTool = createTool({
  id: "inspect",
  description:
    "Have the workbench render an inspection sheet and hand it back to you (free). Use target=\"asset\" + assetSlug for \"check this dog / this model\" (defaults to four views ISO/front/right/top; views can request just some faces, for example the bottom only); use target=\"scene\" for \"check the whole scene / whether the scene is placed correctly\" (captures the full scene image from the camera view given by views[0]); use target=\"closeup\" + assetSlug for \"look up close at whether it fits here\" (contact, floating, clipping, spacing from neighbors) — the camera really flies next to that model and takes a shot with the surrounding environment, then flies back to its original position. This call returns no image: after you receive [Self-check]/[Scene check]/[Close-up check], check each view or camera angle against what the user asked for (missing parts, wrong proportions, disconnected parts, misaligned textures, and unreasonable placement all count as failing). Call it only when the user explicitly asks for an inspection or questions models/scenes already produced; do not self-check after a single-model generation finishes.",
  inputSchema: InspectParamsSchema,
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const storage = getAssetStorage();
    if (input.target === "closeup") {
      if (!input.assetSlug) {
        throw new ChatServiceError("assetSlug is required when target=closeup", 400, "missing_asset_slug");
      }
      // 与 asset 检查同一道前置：没有可渲染模型时立刻失败，避免 app 侧空转
      const modelPath = await latestAssetModel(storage, projectSlug, input.assetSlug);
      return {
        requested: true,
        target: "closeup" as const,
        assetSlug: input.assetSlug,
        modelPath,
        note: `Requested the workbench to fly the camera next to "${input.assetSlug}" for a close-up inspection sheet (the camera flies back to its original position afterwards). ${CLOSEUP_HINT}`,
      };
    }
    if (input.target === "asset") {
      if (!input.assetSlug) {
        throw new ChatServiceError("assetSlug is required when target=asset", 400, "missing_asset_slug");
      }
      // 没有可渲染模型时立刻失败，避免 app 侧空转
      const modelPath = await latestAssetModel(storage, projectSlug, input.assetSlug);
      return {
        requested: true,
        target: "asset" as const,
        assetSlug: input.assetSlug,
        modelPath,
        views: input.views ?? ["iso", "front", "right", "top"],
        note: "Requested a screenshot from the workbench. The 2×2 inspection sheet will be handed back shortly; once you receive it, check each view against the generation intent.",
      };
    }
    // 整场景：项目里一个可渲染的东西都没有时立刻失败，同样不让 app 空转
    const state = await getProjectState(storage, projectSlug);
    const candidates = await Promise.all(
      state.assets.map(async (asset) => {
        try {
          return Boolean(await latestAssetModel(storage, projectSlug, asset.slug));
        } catch {
          return false;
        }
      }),
    );
    if (!candidates.some(Boolean)) {
      throw new ChatServiceError(
        "The project has no renderable models or scene content yet",
        400,
        "empty_scene",
      );
    }
    const view = input.views?.[0] ?? "iso";
    return {
      requested: true,
      target: "scene" as const,
      view,
      views: INSPECTION_VIEW_IDS,
      note: `Requested the workbench to capture a full scene image from camera view "${view}" (not a four-direction image of one model). ${SCENE_VIEW_HINT}`,
    };
  },
});
