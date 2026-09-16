import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { assetDir } from "../../common/libraryPaths";
import { SlugSchema } from "../../dto/library";
import { getAssetStorage, type AssetStorage } from "../../services/assetStorage";
import { latestAssetModel, requireProject } from "./projectTools";
import { requireCurrentProject } from "./requestContext";

/**
 * 视觉自检能力（免费，CADAM 自检循环的 Gabo 变体）：agent 服务端没有渲染能力，
 * 截图由 app/ 视口完成——inspect-asset 只发信号（经 SSE tool 事件带 args 驱动
 * app 开小窗四视角截图），检查图经 POST inspection 端点落盘后，由 app 以
 * **带图用户消息**回传（OpenAI 兼容协议的 tool 消息装不了图，这是唯一通道）。
 * 工具不等待回传：本轮结束，自检发生在带图消息触发的下一轮。
 */

const INSPECTION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const SaveInspectionParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  /** 截图批次 id（app 侧用 toolCallId 或时间戳），限定字符集防路径注入 */
  inspectionId: z.string().regex(INSPECTION_ID_RE, "检查图 id 只能是字母数字、-、_"),
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
    throw new ChatServiceError("检查图内容为空", 400, "empty_inspection");
  }
  const path = `${assetDir(params.projectSlug, params.assetSlug)}/inspections/${params.inspectionId}.png`;
  await storage.writeBytes(path, params.bytes);
  return { path };
}

// ---------- Mastra tool 包装 ----------

export const inspectAssetTool = createTool({
  id: "inspect-asset",
  description:
    "请求工作台对资产的最新模型做四视角截图（免费）：小窗会自动打开并从 ISO/前/右/顶四个视角截图合成一张检查图，以带图的用户消息回传给你。生成/修改模型或贴图完成后应调用此工具自检。注意：本轮不会返回图片——收到检查图消息后，逐视角对照生成意图检查（缺件、比例失调、部件断开、贴图错位都算不合格），不合格就修正后重新生成并再次自检",
  inputSchema: z.object({ assetSlug: SlugSchema }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const storage = getAssetStorage();
    // 没有可渲染模型时立刻失败，避免 app 侧空转
    const modelPath = await latestAssetModel(storage, projectSlug, input.assetSlug);
    return {
      requested: true,
      modelPath,
      note: "已请求工作台截图。检查图将以带图的用户消息回传（四视角 2×2：ISO/前/右/顶），请收到后逐视角自检。",
    };
  },
});
