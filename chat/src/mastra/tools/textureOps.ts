import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { SlugSchema } from "../../dto/library";
import { getAssetStorage } from "../../services/assetStorage";
import { startCustomTask } from "../../services/tasks";
import { requireContextString, requireCurrentProject } from "./requestContext";
import { runTripoTexture } from "./tripoOps";

export const generateTextureTool = createTool({
  id: "generate-texture",
  description:
    "为当前项目已有的 3D 模型通过 Tripo v3 /models/texture 重新生成材质贴图，默认使用最新贴图模型 v3.5-20260815。只使用 Tripo，与对话框选中的图片模型无关。textureQuality=fast 更快但细节更少（贴图尺寸与积分同 standard）。调用前须说明 Tripo 付费操作并取得用户同意。任务化返回，用 list-generation-tasks 跟进。",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    stylePrompt: z.string().min(1).max(600),
    enablePbr: z.boolean().default(true),
    /** 贴图质量档；fast 只比 standard 少细节，尺寸与积分相同。 */
    textureQuality: z.enum(["fast", "standard", "detailed", "extreme"]).optional(),
    /** 是否在贴图前去除参考图里的烘焙光照（Tripo v3.5 贴图模型，默认 true）。 */
    delight: z.boolean().optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const tripoKey = requireContextString(
      context,
      "tripo3dApiKey",
      "本机 chat/.env 未配置 TRIPO_KEY",
    );
    const task = startCustomTask(
      "texture",
      projectSlug,
      `贴图生成（Tripo）：${input.assetSlug}`,
      (task) => runTripoTexture(
        getAssetStorage(),
        {
          projectSlug,
          assetSlug: input.assetSlug,
          prompt: input.stylePrompt,
          pbr: input.enablePbr,
          textureQuality: input.textureQuality,
          delight: input.delight,
        },
        // 阶段必须落盘：贴图是「提交 → 轮询 → 下载几十 MB」，不报阶段时任务全程停在 queued、
        // updatedAt 一动不动，看板上与卡死无法区分（2026-10-02 就是这么挂掉一次）。
        { apiKey: tripoKey, onPhase: (phase) => task.setPhase(phase) },
      ),
      { assetSlug: input.assetSlug, cloudOperation: { operation: "texture", input } },
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});
