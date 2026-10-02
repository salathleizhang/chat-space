import { ChatServiceError, toErrorMessage } from "../../common/errors";
import { formatRequestSidecarName, nextIndex } from "../../common/indexedFiles";
import { assetDir } from "../../common/libraryPaths";
import { config } from "../../config";
import { RequestSidecarSchema, type RequestSidecar } from "../../dto/library";
import { hi3dCommand, hyper3dCommand, submitArk3dTask } from "../../models/ark3d";
import { waitForSeed3dTask, type Seed3dCallOptions } from "../../models/seed3d";
import { getAssetStorage, readAsDataUri, readJson, writeJson, type AssetStorage } from "../../services/assetStorage";
import { runAndPublishGeneratedModel, type GenerationObject } from "../../services/modelPublishing";
import { startCustomTask } from "../../services/tasks";
import { requireProject } from "./projectTools";
import { downloadSeed3dOutputs, resolveSingleImage } from "./seed3dOps";
import { runWithGeneratedModelInfo } from "./modelInfo";

export type Ark3dProvider = "hyper3d-volc" | "hi3d-volc";

export interface Ark3dGenOptions {
  /** 当前会话开始时刻；兜底取图时的归属判据（见 referenceResolution） */
  sessionStartedAt?: number;
  apiKey: string;
  faceCount?: number;
  taPose?: boolean;
  resolution?: "1536" | "1536pro";
  /** 供应商模型 ID；缺省用该渠道在 config 里配置的模型 */
  model?: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
}

/** Seedream 的临时供应商 URL 可喂给数美；本地文件始终是资产库里的正式副本。 */
export async function findVolcImageUrl(
  storage: AssetStorage,
  imagePath: string,
): Promise<string | undefined> {
  const dir = imagePath.split("/").slice(0, -1).join("/");
  for (const name of await storage.list(dir)) {
    if (!/^\.\d+-.+-request\.json$/.test(name)) continue;
    try {
      const sidecar = await readJson(storage, `${dir}/${name}`, RequestSidecarSchema);
      if (sidecar.provider !== "volcengine") continue;
      const url = sidecar.outputs.find((output) => output.path === imagePath)?.providerUrl;
      if (url && /^https:\/\//i.test(url)) return url;
    } catch {
      // 历史或不完整侧写与当前图片无关，继续搜索。
    }
  }
  return undefined;
}

export async function runArk3dImageTo3d(
  storage: AssetStorage,
  provider: Ark3dProvider,
  projectSlug: string,
  assetSlug: string,
  explicitImage: string | undefined,
  options: Ark3dGenOptions,
) {
  await requireProject(storage, projectSlug);
  const imagePath = await resolveSingleImage(
    storage,
    projectSlug,
    assetSlug,
    explicitImage,
    options.sessionStartedAt,
  );
  const image = provider === "hi3d-volc"
    ? await findVolcImageUrl(storage, imagePath)
    : await readAsDataUri(storage, imagePath);
  if (!image) {
    throw new ChatServiceError(
      "火山数美 Hi3D 需要公网图片 URL；请先用 Seedream 生成或编辑参考图",
      409,
      "hi3d_public_image_required",
    );
  }

  const dir = assetDir(projectSlug, assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, assetSlug)}`;
  const model = options.model ??
    (provider === "hi3d-volc" ? config.ark3d.hi3dModel : config.ark3d.hyper3dModel);
  const command = provider === "hi3d-volc"
    ? hi3dCommand(options)
    : hyper3dCommand(options);
  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: assetSlug,
    provider: provider === "hi3d-volc" ? "ark-hitem3d" : "ark-hyper3d",
    model,
    params: {
      image: imagePath,
      command,
      file_format: "glb",
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, { ...sidecar, updatedAt: now() });
  await saveSidecar();

  try {
    const taskId = await submitArk3dTask(
      {
        model,
        images: [image],
        command,
        requirePublicImageUrl: provider === "hi3d-volc",
      },
      options,
    );
    sidecar.providerTaskId = taskId;
    sidecar.status = "running";
    await saveSidecar();
    const pollOptions: Seed3dCallOptions = {
      apiKey: options.apiKey,
      fetchFn: options.fetchFn,
      pollIntervalMs: options.pollIntervalMs,
    };
    const result = await waitForSeed3dTask(taskId, pollOptions);
    const files = await downloadSeed3dOutputs(storage, result, {
      dir,
      index,
      assetSlug,
      sidecar,
      fetchFn: options.fetchFn,
    });
    sidecar.status = "succeeded";
    await saveSidecar();
    return { files, sidecar: sidecarPath, taskId };
  } catch (error) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(error);
    await saveSidecar();
    throw error;
  }
}

export function startArk3dBatch(
  provider: Ark3dProvider,
  projectSlug: string,
  objects: GenerationObject[],
  options: Ark3dGenOptions,
) {
  const label = provider === "hi3d-volc" ? "Hi3D" : "Hyper3D";
  return objects.map((object) =>
    startCustomTask("3d", projectSlug, `3D 生成（火山 ${label}）：${object.name}`, (task) =>
      runAndPublishGeneratedModel(
        getAssetStorage(), projectSlug, task.id, object, task.setPhase,
        // 结果带上真实面数与"是不是高模"：生成完那一轮 Agent 才有依据问用户要不要减面
        (storage) => runWithGeneratedModelInfo(
          storage,
          projectSlug,
          object.slug,
          () => runArk3dImageTo3d(
            storage, provider, projectSlug, object.slug, object.sourceImages[0], options,
          ),
        ),
      ), {
      assetSlug: object.slug,
      retry: {
        kind: "3d",
        assetSlug: object.slug,
        name: object.name,
        intent: object.intent,
        sourceImages: object.sourceImages,
        provider,
        options: {
          faceCount: options.faceCount,
          taPose: options.taPose,
          resolution: options.resolution,
          model: options.model,
        },
      },
    }),
  );
}
