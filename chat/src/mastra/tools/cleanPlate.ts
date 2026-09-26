import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ObjectCandidateSchema, LogicalPathSchema, SlugSchema } from "../../dto/library";
import { IMAGE_CHANNELS, IMAGE_EDIT_MODEL_IDS } from "../../models/images";
import { getAssetStorage } from "../../services/assetStorage";
import { runPlateGeneration } from "./imageEdit";
import {
  currentImageGenerateModel,
  optionalContextString,
  requireCurrentProject,
} from "./requestContext";

export const GenerateCleanPlateInputSchema = z.object({
  /** 独立调用时显式指定源图；省略时才使用项目已确认场景的源图。 */
  sourceImage: LogicalPathSchema.optional(),
  /** 独立调用的移除清单。省略时使用已确认场景的全部对象。 */
  objectsToRemove: z.array(ObjectCandidateSchema).min(1).optional(),
  /** 兼容入口：从已确认场景对象中只移除这些 slug。 */
  objectSlugs: z.array(SlugSchema).min(1).optional(),
  extraInstructions: z.string().min(1).optional(),
  model: z.enum(IMAGE_EDIT_MODEL_IDS).optional(),
  channel: z.enum(IMAGE_CHANNELS).optional(),
}).refine((input) => !(input.objectsToRemove && input.objectSlugs), {
  message: "objectsToRemove 与 objectSlugs 不能同时使用",
});

/**
 * 可独立调用的干净底板能力。SceneJob 和普通对话共用同一实现，
 * 它不要求必须先创建 Workflow/SceneJob。
 */
export const generateCleanPlateTool = createTool({
  id: "generate-clean-plate",
  description:
    "从一张场景图中移除指定家具/物体并修复被遮挡的背景，生成干净底板（付费操作，需用户同意）。可显式传 sourceImage + objectsToRemove 独立调用；省略时可兼容使用已确认场景对象。只生成底板，不会自动生成 World 或 3D 模型。",
  inputSchema: GenerateCleanPlateInputSchema,
  execute: async (input, context) => {
    const result = await runPlateGeneration(
      getAssetStorage(),
      {
        projectSlug: requireCurrentProject(context),
        ...input,
        model: input.model ?? currentImageGenerateModel(context),
      },
      {
        volcengineApiKey:
          optionalContextString(context, "volcengineApiKey") ??
          optionalContextString(context, "seed3dApiKey"),
        googleApiKey: optionalContextString(context, "googleApiKey"),
        openaiApiKey: optionalContextString(context, "openaiApiKey"),
        openrouterApiKey: optionalContextString(context, "openrouterApiKey"),
      },
    );
    return { image: result.output, images: [result.output], sidecar: result.sidecar };
  },
});
