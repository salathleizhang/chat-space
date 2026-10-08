import { config, serverResumeKeys, withServerCredentials } from "../config";
import { Retryable3dTaskSchema, type GenerationTask } from "../dto/tasks";
import { getAssetStorage } from "../services/assetStorage";
import { startWorldTask, type TaskExecutionContext } from "../services/tasks";
import { currentCloudContext, type CloudOperation } from "./context";

/** 队列只保存无密钥的参数，执行时读取当前服务端凭证。 */
export async function executeCloudOperation(task: GenerationTask, job: CloudOperation, execution: TaskExecutionContext): Promise<unknown> {
  const keys = serverResumeKeys();
  const storage = getAssetStorage();
  const input = job.input;
  const projectSlug = task.projectSlug;
  const tripo = { apiKey: keys.tripo3dApiKey ?? "", onPhase: execution.setPhase };
  if (job.operation === "resume") {
    const { resumeGeneration } = await import("../mastra/tools/resumeGeneration");
    return resumeGeneration(storage, String(input.sidecarPath), keys, execution.setPhase);
  }
  if (job.operation === "scene-job") {
    const { runSceneJob } = await import("../services/sceneJobRunner");
    return runSceneJob(projectSlug, String(input.jobId), withServerCredentials({ projectSlug }) as never);
  }
  if (job.operation === "3d" || job.operation === "world") {
    const cloud = currentCloudContext()!;
    const capture = { task, executor: undefined as undefined | ((context: TaskExecutionContext) => Promise<unknown>) };
    cloud.capture = capture;
    try {
      if (job.operation === "world") {
        startWorldTask(projectSlug, { ...input, worldLabsApiKey: keys.worldLabsApiKey ?? "" } as Parameters<typeof startWorldTask>[1]);
      } else {
        const retry = Retryable3dTaskSchema.parse(input.retry);
        const object = { slug: retry.assetSlug, name: retry.name, intent: retry.intent, sourceImages: retry.sourceImages, referenceViews: retry.referenceViews };
        const options = retry.options;
        if (retry.provider === "tripo-direct") {
          const { startTripo3dBatch } = await import("../mastra/tools/tripoOps");
          startTripo3dBatch(projectSlug, [object], { tripo3dApiKey: tripo.apiKey,
            imageModel: typeof options.imageModel === "string" ? options.imageModel : config.tripo.imageModel,
            generationMode: options.generationMode as "auto" | "single" | "multiview" | undefined });
        } else if (retry.provider === "hyper3d-volc" || retry.provider === "hi3d-volc") {
          const { startArk3dBatch } = await import("../mastra/tools/ark3dOps");
          startArk3dBatch(retry.provider, projectSlug, [object], { ...options, apiKey: keys.seed3dApiKey ?? "" });
        } else if (retry.provider === "seed3d-direct") {
          const { startSeed3d3dBatch } = await import("../mastra/tools/seed3dOps");
          startSeed3d3dBatch(projectSlug, [object], { ...options, seed3dApiKey: keys.seed3dApiKey ?? "" });
        } else throw new Error("云端任务的 3D 供应商不受支持");
      }
    } finally { cloud.capture = undefined; }
    if (!capture.executor) throw new Error("无法恢复云端执行函数");
    return capture.executor(execution);
  }
  const assetSlug = String(input.assetSlug);
  const { runTripoTexture, runTripoSegmentation, runTripoRetopology, runTripoRig, runTripoCharacter } = await import("../mastra/tools/tripoOps");
  if (job.operation === "texture") return runTripoTexture(storage, { projectSlug, assetSlug,
    prompt: input.stylePrompt as string, pbr: input.enablePbr as boolean, textureQuality: input.textureQuality as never, delight: input.delight as boolean | undefined }, tripo);
  if (job.operation === "segment") return runTripoSegmentation(storage, { projectSlug, assetSlug }, tripo);
  if (job.operation === "retopo") return runTripoRetopology(storage, { projectSlug, assetSlug,
    faceLimit: input.targetPolycount as number | undefined, quad: input.topology === "quad", model: input.tripoModel as never, bake: input.bake as boolean | undefined }, tripo);
  if (job.operation === "rig") return runTripoRig(storage, { projectSlug, assetSlug,
    rigType: input.rigType as never, spec: input.spec as never, model: input.tripoRigModel as never }, tripo);
  if (job.operation === "character") return runTripoCharacter(storage, { projectSlug, assetSlug,
    image: input.image as string | undefined, spec: input.spec as never, rigModel: input.tripoRigModel as never }, tripo);
  if (job.operation === "uv") {
    const { runHunyuanUvUnwrap } = await import("../mastra/tools/hunyuanOps");
    return runHunyuanUvUnwrap(storage, { projectSlug, assetSlug }, { apiKey: keys.hunyuanApiKey ?? "" });
  }
  throw new Error(`不支持的云端任务：${job.operation}`);
}
