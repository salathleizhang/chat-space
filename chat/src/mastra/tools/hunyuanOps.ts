import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  pickLatestSourceImage,
} from "../../common/indexedFiles";
import {
  assetDir,
  assetIdentityFile,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  RequestSidecarSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import {
  callHunyuanAction,
  submitHunyuanTo3DProJob,
  waitForHunyuanJob,
  type HunyuanCallOptions,
} from "../../models/hunyuan";
import { extractMeshyFileUrls } from "../../models/meshy";
import {
  getAssetStorage,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import {
  publishGeneratedModel,
  runAndPublishGeneratedModel,
  type GenerationObject,
} from "../../services/modelPublishing";
import { startCustomTask } from "../../services/tasks";
import { downloadToLibrary } from "./assetRepair";
import { requireProject } from "./projectTools";
import {
  optionalContextString,
  requireContextString,
  requireCurrentProject,
} from "./requestContext";
import { resolveModelPublicUrl } from "./modelPublicUrl";

/**
 * 混元生 3D 直连能力（腾讯云 TC3，全部 Action 经官方 API 文档核实 2026-07）：
 * hunyuan-direct 生成渠道 + 3D 人物生成（generate-character）+ UV 展开（unwrap-uv）。
 * 图片输入走 Base64（本地优先友好）；模型输入只收公网 URL——经 modelPublicUrl 策略链
 * 解析（优先使用未过期的供应商链接，过期链接作为兜底）。
 */

export const HunyuanGenParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  image: LogicalPathSchema.optional(),
  faceCount: z.number().int().min(3000).max(1500000).optional(),
  generateType: z.enum(["Normal", "LowPoly", "Geometry", "Sketch"]).optional(),
  enablePbr: z.boolean().optional(),
});
export type HunyuanGenParams = z.input<typeof HunyuanGenParamsSchema>;

async function resolveSingleImage(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  explicit?: string,
): Promise<string> {
  if (explicit) {
    if (!(await storage.exists(explicit))) {
      throw new ChatServiceError(`参考图不存在：${explicit}`, 404, "input_image_missing");
    }
    return explicit;
  }
  const identityPath = assetIdentityFile(projectSlug, assetSlug);
  if (await storage.exists(identityPath)) {
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    for (const image of identity.sourceImages) {
      if (await storage.exists(image)) return image;
    }
  }
  const sourceDir = projectSourceDir(projectSlug);
  const latest = pickLatestSourceImage(await storage.list(sourceDir));
  if (!latest) {
    throw new ChatServiceError(
      `项目「${projectSlug}」没有可用参考图，请先上传源图或用 generate-reference-images 生成`,
      409,
      "reference_image_missing",
    );
  }
  return `${sourceDir}/${latest}`;
}

export interface HunyuanOpResult {
  files: string[];
  sidecar: string;
  jobId: string;
}

/** 混元直连图生 3D：图片以 Base64 提交，产物全部落盘 + 侧写 */
export async function runHunyuanImageTo3d(
  storage: AssetStorage,
  rawParams: HunyuanGenParams,
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  const params = HunyuanGenParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  const image = await resolveSingleImage(
    storage,
    params.projectSlug,
    params.assetSlug,
    params.image,
  );

  const dir = assetDir(params.projectSlug, params.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, params.assetSlug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.assetSlug,
    provider: "hunyuan",
    model: "SubmitHunyuanTo3DProJob",
    params: {
      image,
      ...(params.faceCount !== undefined ? { face_count: params.faceCount } : {}),
      ...(params.generateType ? { generate_type: params.generateType } : {}),
      ...(params.enablePbr !== undefined ? { enable_pbr: params.enablePbr } : {}),
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, {
      ...sidecar,
      updatedAt: now(),
    });
  await saveSidecar();

  try {
    const bytes = await storage.readBytes(image);
    const jobId = await submitHunyuanTo3DProJob(
      {
        imageBase64: Buffer.from(bytes).toString("base64"),
        faceCount: params.faceCount,
        generateType: params.generateType,
        enablePbr: params.enablePbr,
      },
      callOptions,
    );
    sidecar.providerTaskId = jobId;
    sidecar.status = "running";
    await saveSidecar();

    const result = await waitForHunyuanJob("QueryHunyuanTo3DProJob", jobId, callOptions);
    const refs = extractMeshyFileUrls(result);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const ref of refs) {
      if (seen.has(ref.url)) continue;
      seen.add(ref.url);
      const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(ref.url)?.[1]?.toLowerCase() ?? "bin";
      const fileSlug =
        files.length === 0 ? params.assetSlug : `${params.assetSlug}-f${files.length + 1}`;
      const path = `${dir}/${formatIndexedName(index, fileSlug, ext)}`;
      await downloadToLibrary(storage, ref.url, path, { fetchFn: callOptions.fetchFn });
      files.push(path);
      sidecar.outputs.push({ path, providerUrl: ref.url });
    }
    if (files.length === 0) {
      throw new ChatServiceError("混元结果中没有可下载文件", 502, "hunyuan_no_files");
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    return { files, sidecar: sidecarPath, jobId };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

/** 通用：提交任意混元 Job → 轮询 Describe → ResultFile3Ds 全部落盘（共享新索引 + 侧写） */
async function runHunyuanAssetJob(
  storage: AssetStorage,
  request: {
    projectSlug: string;
    assetSlug: string;
    submitAction: string;
    queryAction: string;
    payload: Record<string, unknown>;
    sidecarParams: Record<string, unknown>;
  },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, request.projectSlug);
  const dir = assetDir(request.projectSlug, request.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, request.assetSlug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: request.assetSlug,
    provider: "hunyuan",
    model: request.submitAction,
    params: request.sidecarParams,
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, {
      ...sidecar,
      updatedAt: now(),
    });
  await saveSidecar();

  try {
    const submitResult = await callHunyuanAction(
      request.submitAction,
      request.payload,
      callOptions,
    );
    const jobId = submitResult.JobId;
    if (typeof jobId !== "string" || !jobId) {
      throw new ChatServiceError("混元提交响应缺少 JobId", 502, "hunyuan_request_failed");
    }
    sidecar.providerTaskId = jobId;
    sidecar.status = "running";
    await saveSidecar();

    const result = await waitForHunyuanJob(request.queryAction, jobId, callOptions);
    const refs = extractMeshyFileUrls(result);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const ref of refs) {
      if (seen.has(ref.url)) continue;
      seen.add(ref.url);
      const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(ref.url)?.[1]?.toLowerCase() ?? "bin";
      const fileSlug =
        files.length === 0 ? request.assetSlug : `${request.assetSlug}-f${files.length + 1}`;
      const path = `${dir}/${formatIndexedName(index, fileSlug, ext)}`;
      await downloadToLibrary(storage, ref.url, path, { fetchFn: callOptions.fetchFn });
      files.push(path);
      sidecar.outputs.push({ path, providerUrl: ref.url });
    }
    if (files.length === 0) {
      throw new ChatServiceError("混元结果中没有可下载文件", 502, "hunyuan_no_files");
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    return { files, sidecar: sidecarPath, jobId };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

/** 3D 人物生成（带绑骨，混元专属）：参考图 Base64 + 可选人物模板 */
export async function runProfileTo3d(
  storage: AssetStorage,
  params: {
    projectSlug: string;
    assetSlug: string;
    image?: string;
    template?: string;
  },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, params.projectSlug);
  const image = await resolveSingleImage(
    storage,
    params.projectSlug,
    params.assetSlug,
    params.image,
  );
  const bytes = await storage.readBytes(image);
  const result = await runHunyuanAssetJob(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      submitAction: "SubmitProfileTo3DJob",
      queryAction: "DescribeProfileTo3DJob",
      payload: {
        Profile: { Base64: Buffer.from(bytes).toString("base64") },
        ...(params.template ? { Template: params.template } : {}),
      },
      sidecarParams: {
        image,
        ...(params.template ? { template: params.template } : {}),
      },
    },
    callOptions,
  );
  await publishGeneratedModel(
    storage,
    params.projectSlug,
    {
      slug: params.assetSlug,
      name: params.assetSlug,
      intent: `Rigged 3D character of ${params.assetSlug}`,
      sourceImages: [image],
    },
    result,
  );
  return result;
}

/** 模型公网 URL 解析（modelPublicUrl 策略链），从资产侧写查找供应商链接 */
function resolveModel(storage: AssetStorage, projectSlug: string, assetSlug: string) {
  return resolveModelPublicUrl(storage, projectSlug, assetSlug);
}

/** UV 展开（混元专属）：模型经公网 URL 传入（modelPublicUrl 解析） */
export async function runHunyuanUvUnwrap(
  storage: AssetStorage,
  params: { projectSlug: string; assetSlug: string },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, params.projectSlug);
  const model = await resolveModel(
    storage,
    params.projectSlug,
    params.assetSlug,
  );
  return runHunyuanAssetJob(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      submitAction: "SubmitHunyuanTo3DUVJob",
      queryAction: "DescribeHunyuanTo3DUVJob",
      payload: { File: { Url: model.url, Type: model.type } },
      sidecarParams: {
        input_model_url: model.url,
        input_type: model.type,
      },
    },
    callOptions,
  );
}

/** hunyuan-direct 的批量 3D 生成（与 tripoOps.startTripo3dBatch 同构） */
export function startHunyuan3dBatch(
  projectSlug: string,
  objects: GenerationObject[],
  options: {
    hunyuanApiKey: string;
    faceCount?: number;
    generateType?: "Normal" | "LowPoly" | "Geometry" | "Sketch";
    enablePbr?: boolean;
  },
) {
  return objects.map((object) =>
    startCustomTask("3d", projectSlug, `3D 生成（混元直连）：${object.name}`, (task) =>
      runAndPublishGeneratedModel(
        getAssetStorage(), projectSlug, task.id, object, task.setPhase,
        (target) => runHunyuanImageTo3d(
          target,
          {
            projectSlug,
            assetSlug: object.slug,
            image: object.sourceImages[0],
            faceCount: options.faceCount,
            generateType: options.generateType,
            enablePbr: options.enablePbr,
          },
          { apiKey: options.hunyuanApiKey },
        ),
      ), {
      assetSlug: object.slug,
      retry: {
        kind: "3d", assetSlug: object.slug, name: object.name, intent: object.intent,
        sourceImages: object.sourceImages, provider: "hunyuan-direct",
        options: { faceCount: options.faceCount, generateType: options.generateType, enablePbr: options.enablePbr },
      },
    }),
  );
}

// ---------- Mastra tool 包装（付费，闸门 + 任务化） ----------

export const generateCharacterTool = createTool({
  id: "generate-character",
  description:
    "生成带绑骨的 3D 人物（腾讯混元专属，付费操作——启动前须经用户同意）：参考图（省略时用身份绑定/最新源图）+ 可选人物模板（如 basketball/pingpong/guitar/futuresoilder/explorer 等）。产物含绑骨可直接驱动。任务化返回，用 list-generation-tasks 跟进",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    image: LogicalPathSchema.optional(),
    template: z.string().optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const apiKey = requireContextString(
      context,
      "hunyuanApiKey",
      "缺少混元 API key（腾讯云「SecretId:SecretKey」，请用户在设置中填写）",
    );
    const task = startCustomTask(
      "character",
      projectSlug,
      `3D 人物生成：${input.assetSlug}`,
      () =>
        runProfileTo3d(
          getAssetStorage(),
          { projectSlug, assetSlug: input.assetSlug, image: input.image, template: input.template },
          { apiKey },
        ),
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});

export const unwrapUvTool = createTool({
  id: "unwrap-uv",
  description:
    "对资产的最新模型做 UV 展开（腾讯混元专属，付费操作——启动前须经用户同意）。模型输入需公网 URL：优先用未过期的供应商链接，并使用可访问的供应商链接。任务化返回",
  inputSchema: z.object({
    assetSlug: SlugSchema,
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const apiKey = requireContextString(
      context,
      "hunyuanApiKey",
      "缺少混元 API key（腾讯云「SecretId:SecretKey」，请用户在设置中填写）",
    );
    const task = startCustomTask(
      "uv",
      projectSlug,
      `UV 展开：${input.assetSlug}`,
      () =>
        runHunyuanUvUnwrap(
          getAssetStorage(),
          { projectSlug, assetSlug: input.assetSlug },
          { apiKey },
        ),
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});

// ---------- 后处理渠道函数（供 meshOps/tripoOps 工具按 channel 分发；Action 经官方文档核实 2026-07） ----------

/** 贴图重生成（SubmitTextureTo3DJob）：模型经公网 URL，风格用文字提示 */
export async function runHunyuanTexture(
  storage: AssetStorage,
  params: { projectSlug: string; assetSlug: string; prompt: string; enablePbr?: boolean },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, params.projectSlug);
  const model = await resolveModel(storage, params.projectSlug, params.assetSlug);
  return runHunyuanAssetJob(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      submitAction: "SubmitTextureTo3DJob",
      queryAction: "DescribeTextureTo3DJob",
      payload: {
        File: { Url: model.url, Type: model.type },
        Prompt: params.prompt,
        ...(params.enablePbr !== undefined ? { EnablePBR: params.enablePbr } : {}),
      },
      sidecarParams: {
        input_model_url: model.url,
        prompt: params.prompt,
      },
    },
    callOptions,
  );
}

/** 智能拓扑（SubmitReduceFaceJob，注意字段名是 File3D）：FaceLevel high/medium/low */
export async function runHunyuanRetopo(
  storage: AssetStorage,
  params: {
    projectSlug: string;
    assetSlug: string;
    faceLevel?: "high" | "medium" | "low";
    polygonType?: "triangle" | "quadrilateral";
  },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, params.projectSlug);
  const model = await resolveModel(storage, params.projectSlug, params.assetSlug);
  return runHunyuanAssetJob(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      submitAction: "SubmitReduceFaceJob",
      queryAction: "DescribeReduceFaceJob",
      payload: {
        File3D: { Url: model.url, Type: model.type },
        ...(params.faceLevel ? { FaceLevel: params.faceLevel } : {}),
        ...(params.polygonType ? { PolygonType: params.polygonType } : {}),
      },
      sidecarParams: {
        input_model_url: model.url,
        ...(params.faceLevel ? { face_level: params.faceLevel } : {}),
        ...(params.polygonType ? { polygon_type: params.polygonType } : {}),
      },
    },
    callOptions,
  );
}

/** 绑骨蒙皮（SubmitAutoRiggingJob）：FBX/GLB ≤60MB，建议 A/T-pose；可带 1–48 预设动画 */
export async function runHunyuanRig(
  storage: AssetStorage,
  params: { projectSlug: string; assetSlug: string; motionType?: number },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, params.projectSlug);
  const model = await resolveModel(storage, params.projectSlug, params.assetSlug);
  return runHunyuanAssetJob(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      submitAction: "SubmitAutoRiggingJob",
      queryAction: "DescribeAutoRiggingJob",
      payload: {
        File: { Url: model.url, Type: model.type },
        ...(params.motionType !== undefined ? { MotionType: params.motionType } : {}),
      },
      sidecarParams: {
        input_model_url: model.url,
        ...(params.motionType !== undefined ? { motion_type: params.motionType } : {}),
      },
    },
    callOptions,
  );
}

/** 组件生成（SubmitHunyuan3DPartJob）：仅收 FBX——资产最新模型须是 FBX */
export async function runHunyuanPartSegmentation(
  storage: AssetStorage,
  params: { projectSlug: string; assetSlug: string },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, params.projectSlug);
  const model = await resolveModel(storage, params.projectSlug, params.assetSlug);
  if (model.type !== "FBX") {
    throw new ChatServiceError(
      `混元组件生成仅支持 FBX 输入，资产「${params.assetSlug}」最新产物是 ${model.type}——可改用 tripo 渠道，或先经 Meshy 产出 FBX`,
      400,
      "fbx_required",
    );
  }
  return runHunyuanAssetJob(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      submitAction: "SubmitHunyuan3DPartJob",
      queryAction: "QueryHunyuan3DPartJob",
      payload: { File: { Url: model.url, Type: model.type } },
      sidecarParams: {
        input_model_url: model.url,
      },
    },
    callOptions,
  );
}

/** 文生动作（SubmitHunyuanTo3DMotionJob）：纯文字生成 FBX 动画（1–12 秒，默认含蒙皮网格） */
export async function runHunyuanMotion(
  storage: AssetStorage,
  params: { projectSlug: string; assetSlug: string; prompt: string; duration?: number },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, params.projectSlug);
  return runHunyuanAssetJob(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      submitAction: "SubmitHunyuanTo3DMotionJob",
      queryAction: "DescribeHunyuanTo3DMotionJob",
      payload: {
        Prompt: params.prompt,
        ...(params.duration !== undefined ? { Duration: params.duration } : {}),
      },
      sidecarParams: {
        prompt: params.prompt,
        ...(params.duration !== undefined ? { duration: params.duration } : {}),
      },
    },
    callOptions,
  );
}
