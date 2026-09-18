import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import {
  assetDir,
  assetIdentityFile,
  projectAnalysisFile,
  projectAssetsDir,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  ObjectCandidateSchema,
  RequestSidecarSchema,
  SceneAnalysisSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import { getAssetStorage, readJson, type AssetStorage } from "../../services/assetStorage";
import { readCandidates } from "../../services/candidateRegistry";
import { renderablePathsFromResult } from "../../services/modelPublishing";
import { findRunningTask, getTask, startCustomTask } from "../../services/tasks";
import { buildRequestContext, type RunKeys } from "../../services/workflowRuns";
import { composePlatePrompt, runPlateGeneration } from "../tools/falImageEdit";
import { runReferenceImageEdit } from "../tools/referenceImage";
import { setCurrentWorld } from "../tools/projectTools";
import { startSeed3d3dBatch } from "../tools/seed3dOps";
import { composeEmptyWorldPrompt, runProjectWorldGeneration } from "../tools/worldGen";

const InputSchema = z.object({ projectSlug: SlugSchema });
const ConfirmedSceneSchema = InputSchema.extend({
  sourceImage: LogicalPathSchema,
  objects: z.array(ObjectCandidateSchema).min(1),
});
const ReferenceSchema = ObjectCandidateSchema.extend({ image: LogicalPathSchema });
const ReferencesReadySchema = ConfirmedSceneSchema.extend({
  references: z.array(ReferenceSchema).min(1),
});
const PlateReadySchema = ReferencesReadySchema.extend({ plate: LogicalPathSchema });
const WorldReadySchema = PlateReadySchema.extend({
  worldJson: LogicalPathSchema,
  worldFiles: z.array(LogicalPathSchema),
});
const OutputSchema = z.object({
  projectSlug: SlugSchema,
  plate: LogicalPathSchema,
  worldJson: LogicalPathSchema,
  worldFiles: z.array(LogicalPathSchema),
  references: z.array(ReferenceSchema),
  models: z.array(z.object({ slug: SlugSchema, files: z.array(LogicalPathSchema).min(1) })),
});

function requiredKey(context: { get: (key: string) => unknown } | undefined, name: string): string {
  const value = context?.get(name);
  if (typeof value === "string" && value.length > 0) return value;
  throw new ChatServiceError(
    `完整场景生成需要本机 chat/.env 配置 ${name === "worldLabsApiKey" ? "WORLDLABS_KEY" : "VOLC_KEY"}`,
    401,
    "one_shot_missing_key",
  );
}

function isolatePrompt(object: z.infer<typeof ObjectCandidateSchema>): string {
  return `Isolate the single ${object.name} (${object.description}) from the source image. ` +
    "Reproduce its colors, materials, proportions, and visible details faithfully. " +
    "Show the complete object centered on a plain white background, with space around every edge. " +
    "Remove other objects, people, scenery, text, and shadows on the ground.";
}

/** 已完成且全部文件仍在的请求才可复用；参数必须匹配本次场景输入。 */
async function succeededSidecar(
  storage: AssetStorage,
  dir: string,
  matches: (sidecar: RequestSidecar) => boolean,
): Promise<RequestSidecar | undefined> {
  const names = (await storage.list(dir))
    .filter((name) => /^\.\d+-[a-z0-9-]+-request\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of names) {
    let sidecar: RequestSidecar;
    try {
      sidecar = await readJson(storage, `${dir}/${name}`, RequestSidecarSchema);
    } catch {
      continue;
    }
    if (sidecar.status !== "succeeded" || sidecar.outputs.length === 0 || !matches(sidecar)) continue;
    if ((await Promise.all(sidecar.outputs.map((output) => storage.exists(output.path)))).every(Boolean)) {
      return sidecar;
    }
  }
  return undefined;
}

async function waitForModelTasks(
  projectSlug: string,
  tasks: { id: string; subject: string; assetSlug?: string }[],
): Promise<z.infer<typeof OutputSchema>["models"]> {
  const pending = new Set(tasks.map((task) => task.id));
  const results = new Map<string, string[]>();
  const failures: string[] = [];
  while (pending.size > 0) {
    for (const id of [...pending]) {
      const task = await getTask(projectSlug, id);
      if (!task || task.status === "running") continue;
      pending.delete(id);
      if (task.status === "failed") {
        failures.push(`${task.subject}：${task.error ?? "未知错误"}`);
        continue;
      }
      const value = task.result as { files?: unknown } | undefined;
      const files = Array.isArray(value?.files)
        ? value.files.filter((file): file is string => typeof file === "string")
        : [];
      if (files.length === 0) {
        failures.push(`${task.subject}：没有落盘模型文件`);
        continue;
      }
      results.set(id, files);
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (failures.length > 0) {
    throw new ChatServiceError(`物体生成失败：${failures.join("；")}`, 502, "one_shot_model_failed");
  }
  return tasks.map((task) => {
    return { slug: task.assetSlug!, files: results.get(task.id)! };
  });
}

/** 确认记录是付费流程的入口；这份 analysis.json 只由 confirm-reference-assets 写入。 */
const loadConfirmedScene = createStep({
  id: "load-confirmed-scene",
  inputSchema: InputSchema,
  outputSchema: ConfirmedSceneSchema,
  execute: async ({ inputData, requestContext }) => {
    requiredKey(requestContext, "volcengineApiKey");
    requiredKey(requestContext, "seed3dApiKey");
    requiredKey(requestContext, "worldLabsApiKey");
    const storage = getAssetStorage();
    const analysisPath = projectAnalysisFile(inputData.projectSlug);
    if (!(await storage.exists(analysisPath))) {
      throw new ChatServiceError(
        `项目「${inputData.projectSlug}」还没有已确认的参考图资产分析，请先用 analyze-reference + confirm-reference-assets 确认对象`,
        409,
        "analysis_missing",
      );
    }
    const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);
    const sourceImage = analysis.sources[0];
    if (!sourceImage || !(await storage.exists(sourceImage))) {
      throw new ChatServiceError("已确认场景的源图不存在", 409, "source_image_missing");
    }
    if (analysis.objects.length === 0) {
      throw new ChatServiceError("已确认场景没有可生成的对象", 409, "no_objects");
    }
    return {
      projectSlug: inputData.projectSlug,
      sourceImage,
      objects: analysis.objects.map(({ slug, name, description }) => ({ slug, name, description })),
    };
  },
});

const extractReferences = createStep({
  id: "extract-object-references",
  inputSchema: ConfirmedSceneSchema,
  outputSchema: ReferencesReadySchema,
  execute: async ({ inputData, requestContext }) => {
    const storage = getAssetStorage();
    const key = requiredKey(requestContext, "volcengineApiKey");
    const candidates = await readCandidates(storage, inputData.projectSlug);
    const references: z.infer<typeof ReferenceSchema>[] = [];
    // 逐对象完成并落盘；失败后重新启动时复用已绑定的独立参考图，避免再次付费。
    for (const object of inputData.objects) {
      const candidate = candidates.objects.find((item) => item.slug === object.slug);
      const identityPath = assetIdentityFile(inputData.projectSlug, object.slug);
      const identity = await storage.exists(identityPath)
        ? await readJson(storage, identityPath, AssetIdentitySchema)
        : undefined;
      const reusable = await (async () => {
        for (const path of [...(candidate?.sourceImages ?? []), ...(identity?.sourceImages ?? [])]) {
          if (path !== inputData.sourceImage && await storage.exists(path)) return path;
        }
        return undefined;
      })();
      const image = reusable ?? (await runReferenceImageEdit(
        storage,
        { projectSlug: inputData.projectSlug, assetSlug: object.slug, prompt: isolatePrompt(object) },
        { volcengineApiKey: key },
      )).image;
      references.push({ ...object, image });
    }
    return { ...inputData, references };
  },
});

const generatePlate = createStep({
  id: "generate-clean-plate",
  inputSchema: ReferencesReadySchema,
  outputSchema: PlateReadySchema,
  execute: async ({ inputData, requestContext }) => {
    const key = requiredKey(requestContext, "volcengineApiKey");
    const sourceDir = projectSourceDir(inputData.projectSlug);
    const prompt = composePlatePrompt(inputData.objects);
    const existing = await succeededSidecar(getAssetStorage(), sourceDir, (sidecar) =>
      sidecar.params.role === "plate" &&
      sidecar.params.prompt === prompt &&
      Array.isArray(sidecar.params.input_images) &&
      sidecar.params.input_images.length === 1 &&
      sidecar.params.input_images[0] === inputData.sourceImage,
    );
    if (existing) {
      const plate = existing.outputs.find((output) => /\.(png|jpe?g|webp)$/i.test(output.path));
      if (plate) return { ...inputData, plate: plate.path };
    }
    const plate = await runPlateGeneration(
      getAssetStorage(),
      { projectSlug: inputData.projectSlug, sourceImage: inputData.sourceImage },
      { volcengineApiKey: key },
    );
    return { ...inputData, plate: plate.output };
  },
});

const generateWorld = createStep({
  id: "generate-empty-world",
  inputSchema: PlateReadySchema,
  outputSchema: WorldReadySchema,
  execute: async ({ inputData, requestContext }) => {
    const key = requiredKey(requestContext, "worldLabsApiKey");
    const storage = getAssetStorage();
    const analysis = await readJson(storage, projectAnalysisFile(inputData.projectSlug), SceneAnalysisSchema);
    const prompt = composeEmptyWorldPrompt(analysis);
    for (const slug of await storage.list(projectAssetsDir(inputData.projectSlug))) {
      if (!SlugSchema.safeParse(slug).success) continue;
      if (!(await storage.exists(assetIdentityFile(inputData.projectSlug, slug)))) continue;
      const identity = await readJson(storage, assetIdentityFile(inputData.projectSlug, slug), AssetIdentitySchema);
      if (identity.kind !== "world") continue;
      const existing = await succeededSidecar(storage, assetDir(inputData.projectSlug, slug), (sidecar) =>
        sidecar.provider === "world-labs" &&
        sidecar.params.image === inputData.plate &&
        sidecar.params.prompt === prompt,
      );
      const worldJson = existing?.outputs.find((output) => output.path.endsWith(".json"))?.path;
      if (worldJson) {
        await setCurrentWorld(storage, inputData.projectSlug, slug);
        return {
          ...inputData,
          worldJson,
          worldFiles: existing!.outputs.filter((output) => output.path !== worldJson).map((output) => output.path),
        };
      }
    }
    const world = await runProjectWorldGeneration(
      storage,
      { projectSlug: inputData.projectSlug, mode: "empty-environment", sourceImage: inputData.plate },
      { apiKey: key },
    );
    return { ...inputData, worldJson: world.worldJson, worldFiles: world.files };
  },
});

const generateModels = createStep({
  id: "generate-object-models",
  inputSchema: WorldReadySchema,
  outputSchema: OutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const key = requiredKey(requestContext, "seed3dApiKey");
    const storage = getAssetStorage();
    const reused = new Map<string, string[]>();
    const missing: typeof inputData.references = [];
    for (const object of inputData.references) {
      const identityPath = assetIdentityFile(inputData.projectSlug, object.slug);
      if (await storage.exists(identityPath)) {
        const identity = await readJson(storage, identityPath, AssetIdentitySchema);
        if (identity.kind === "model") {
          const existing = await succeededSidecar(storage, assetDir(inputData.projectSlug, object.slug), (sidecar) =>
            sidecar.provider === "seed3d" && sidecar.params.image === object.image,
          );
          const files = renderablePathsFromResult({ files: existing?.outputs.map((output) => output.path) });
          if (files.length > 0) {
            reused.set(object.slug, files);
            continue;
          }
        }
      }
      missing.push(object);
    }
    const started = startSeed3d3dBatch(
      inputData.projectSlug,
      missing.map((object) => ({
        slug: object.slug,
        name: object.name,
        intent: object.description,
        sourceImages: [object.image],
      })),
      { seed3dApiKey: key },
    );
    const completed = await waitForModelTasks(inputData.projectSlug, started);
    for (const model of completed) reused.set(model.slug, model.files);
    return {
      projectSlug: inputData.projectSlug,
      plate: inputData.plate,
      worldJson: inputData.worldJson,
      worldFiles: inputData.worldFiles,
      references: inputData.references,
      models: inputData.references.map((object) => ({ slug: object.slug, files: reused.get(object.slug)! })),
    };
  },
});

export const oneShotWorkflow = createWorkflow({
  id: "one-shot-scene",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .then(loadConfirmedScene)
  .then(extractReferences)
  .then(generatePlate)
  .then(generateWorld)
  .then(generateModels)
  .commit();

export async function runOneShotWorkflow(projectSlug: string, keys: RunKeys) {
  const run = await oneShotWorkflow.createRun();
  const result = await run.start({
    inputData: { projectSlug },
    requestContext: buildRequestContext({ ...keys, projectSlug }),
  });
  if (result.status === "success") return result.result;
  if (result.status === "failed") {
    const failedStep = Object.entries(result.steps).find(([, step]) => step?.status === "failed");
    const error = failedStep?.[1] && "error" in failedStep[1] ? failedStep[1].error : undefined;
    throw new ChatServiceError(
      `完整场景生成在 ${failedStep?.[0] ?? "未知步骤"} 失败：${String(error ?? "未知错误")}`,
      502,
      "one_shot_failed",
    );
  }
  throw new ChatServiceError(`完整场景生成未完成：${result.status}`, 409, "one_shot_incomplete");
}

/** Agent 直接调用的 Workflow 入口：立即返回总任务，完整生成在后台运行。 */
export const oneShotSceneWorkflow = createWorkflow({
  id: "one-shot-scene-launch",
  description:
    "已确认对象且用户同意完整付费生成后，启动完整场景生成：独立参考图、干净底板、World Labs 空环境和 Seed3D 单物体模型。只调用一次；返回总任务供进度跟踪。",
  inputSchema: z.object({}),
  outputSchema: z.object({
    task: z.object({ id: z.string(), subject: z.string(), status: z.literal("running") }),
  }),
})
  .then(createStep({
    id: "start-one-shot-task",
    inputSchema: z.object({}),
    outputSchema: z.object({
      task: z.object({ id: z.string(), subject: z.string(), status: z.literal("running") }),
    }),
    execute: async ({ requestContext }) => {
      const projectSlug = SlugSchema.parse(requestContext?.get("projectSlug"));
      const running = findRunningTask(projectSlug, "one-shot");
      if (running) return { task: { id: running.id, subject: running.subject, status: "running" as const } };
      const keys: RunKeys = {
        volcengineApiKey: requiredKey(requestContext, "volcengineApiKey"),
        seed3dApiKey: requiredKey(requestContext, "seed3dApiKey"),
        worldLabsApiKey: requiredKey(requestContext, "worldLabsApiKey"),
      };
      const task = startCustomTask("one-shot", projectSlug, "完整场景生成", async (execution) => {
        await execution.setPhase("generating");
        return runOneShotWorkflow(projectSlug, keys);
      });
      return { task: { id: task.id, subject: task.subject, status: "running" as const } };
    },
  }))
  .commit();
