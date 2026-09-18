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
    "为当前项目已有的 3D 模型通过 Tripo v3 /models/texture 重新生成材质贴图。只使用 Tripo，与对话框选中的图片模型无关。调用前须说明 Tripo 付费操作并取得用户同意。任务化返回，用 list-generation-tasks 跟进。",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    stylePrompt: z.string().min(1).max(600),
    enablePbr: z.boolean().default(true),
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
      () => runTripoTexture(
        getAssetStorage(),
        { projectSlug, assetSlug: input.assetSlug, prompt: input.stylePrompt, pbr: input.enablePbr },
        { apiKey: tripoKey },
      ),
      { assetSlug: input.assetSlug },
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});
