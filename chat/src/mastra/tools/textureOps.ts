import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { SlugSchema } from "../../dto/library";
import { getAssetStorage } from "../../services/assetStorage";
import { TEXTURE_TILES, runLocalTexture } from "../../services/localTexture";
import { startCustomTask } from "../../services/tasks";
import { requireContextString, requireCurrentProject } from "./requestContext";

/**
 * 贴图改由火山生图引擎（Seedream）出图 + 本地盒式投影写入 GLB —— 不再调用 Tripo
 * `/models/texture`。生图计费在火山那边，与聊天里选的图片模型无关。
 */
export const generateTextureTool = createTool({
  id: "generate-texture",
  description:
    "Regenerate the material of an existing 3D model **locally**: Volcano Engine Seedream draws one seamless tileable material image from your prompt, then the tool box-projects it onto the model and writes a new GLB generation (no Tripo, no UV unwrap step). Use it when the user wants a different material (wood, fabric, leather, paint) or the generated model's texture looks wrong. `stylePrompt` describes the material only — colour, grain, finish — not the object. textureScale = how many times the tile repeats along the model's longest edge (default 4; lower for a big pattern, higher for fine grain). Note it produces a generic material, not a repaint of the reference photo, and box projection leaves a slight seam at hard edges. Returns a task; follow up with list-generation-tasks.",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    /** 材质描述，例如 "warm oak wood, matte finish" */
    stylePrompt: z.string().min(1).max(600),
    textureScale: z
      .number()
      .int()
      .min(TEXTURE_TILES.min)
      .max(TEXTURE_TILES.max)
      .optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const volcengineApiKey = requireContextString(
      context,
      "volcengineApiKey",
      "VOLC_KEY is not configured in the local chat/.env",
    );
    const task = startCustomTask(
      "texture",
      projectSlug,
      `Material (Seedream): ${input.assetSlug}`,
      (task) =>
        // 阶段必须落盘：生图 + 写入 GLB 都要能被看板看见，否则全程停在 queued
        runLocalTexture(getAssetStorage(), {
          projectSlug,
          assetSlug: input.assetSlug,
          prompt: input.stylePrompt,
          tiles: input.textureScale,
          volcengineApiKey,
          onPhase: (phase) => task.setPhase(phase),
        }),
      { assetSlug: input.assetSlug, cloudOperation: { operation: "texture", input } },
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});
