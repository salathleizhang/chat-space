import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  parseRequestSidecarName,
} from "../../common/indexedFiles";
import { assetDir } from "../../common/libraryPaths";
import {
  RequestSidecarSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import {
  createMeshyTask,
  extractMeshyFileUrls,
  MESHY_PATHS,
  waitForMeshyTask,
  type MeshyCallOptions,
  type MeshyCapabilityPath,
} from "../../models/meshy";
import {
  getAssetStorage,
  readAsDataUri,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { startCustomTask } from "../../services/tasks";
import { downloadToLibrary } from "./assetRepair";
import {
  runHunyuanMotion,
  runHunyuanRetopo,
  runHunyuanRig,
} from "./hunyuanOps";
import { latestAssetModel, requireProject } from "./projectTools";
import { runTripoRig } from "./tripoOps";
import {
  optionalContextString,
  requireContextString,
  requireCurrentProject,
} from "./requestContext";

/**
 * 模型后处理能力（工具优先：每个工具一条能力，内部按渠道路由）。
 * 第一批渠道 = Meshy 直连（端点核实 2026-07，模型输入收 data URI 免上传）；
 * 混元 / Tripo / Hyper3D 渠道待端点核实后补入（部件分割 / UV 展开 / 角色生成同批挂账）。
 * 输入 = 资产库里已有模型（取该资产最高索引模型文件）；输出共享新索引 + 侧写。
 */

export type MeshOperation = "texture" | "retopo" | "rig" | "animation" | "segment";

/** 该资产最近一次成功的 Meshy 绑骨任务 id（动作生成的链式输入） */
async function findMeshyRigTaskId(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
): Promise<string> {
  const dir = assetDir(projectSlug, assetSlug);
  let best: { index: number; taskId: string } | null = null;
  for (const name of await storage.list(dir)) {
    if (!parseRequestSidecarName(name)) continue;
    try {
      const sidecar = await readJson(storage, `${dir}/${name}`, RequestSidecarSchema);
      if (
        sidecar.provider === "meshy" &&
        sidecar.model === MESHY_PATHS.rigging &&
        sidecar.status === "succeeded" &&
        sidecar.providerTaskId &&
        (!best || sidecar.index > best.index)
      ) {
        best = { index: sidecar.index, taskId: sidecar.providerTaskId };
      }
    } catch {
      // 坏侧写不阻塞扫描
    }
  }
  if (!best) {
    throw new ChatServiceError(
      `资产「${assetSlug}」还没有成功的绑骨记录，请先用 rig-model 绑骨`,
      409,
      "rig_missing",
    );
  }
  return best.taskId;
}

interface MeshOpRequest {
  projectSlug: string;
  assetSlug: string;
  path: MeshyCapabilityPath;
  /** 已核实的 Meshy 请求体（模型输入由引擎注入） */
  body: Record<string, unknown>;
  /** 需要把资产最新模型转成 data URI 注入到该字段 */
  modelField?: string;
  /** 侧写记录的参数（禁密钥） */
  sidecarParams: Record<string, unknown>;
}

export interface MeshOpResult {
  files: string[];
  sidecar: string;
  meshyTaskId: string;
}

/** 通用引擎：解析输入 → 建 Meshy 任务 → 轮询 → 全部产物落盘（磁盘不齐不算成功） */
export async function runMeshOperation(
  storage: AssetStorage,
  request: MeshOpRequest,
  callOptions: MeshyCallOptions,
): Promise<MeshOpResult> {
  await requireProject(storage, request.projectSlug);
  const dir = assetDir(request.projectSlug, request.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, request.assetSlug)}`;

  const body = { ...request.body };
  if (request.modelField) {
    const modelPath = await latestAssetModel(
      storage,
      request.projectSlug,
      request.assetSlug,
    );
    body[request.modelField] = await readAsDataUri(storage, modelPath);
    request.sidecarParams.input_model = modelPath;
  }

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: request.assetSlug,
    provider: "meshy",
    model: request.path,
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
    const taskId = await createMeshyTask(request.path, body, callOptions);
    sidecar.providerTaskId = taskId;
    sidecar.status = "running";
    await saveSidecar();

    const task = await waitForMeshyTask(request.path, taskId, callOptions);
    const refs = extractMeshyFileUrls(task);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const ref of refs) {
      if (seen.has(ref.url)) continue;
      seen.add(ref.url);
      const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(ref.url)?.[1]?.toLowerCase() ?? "bin";
      const fileSlug =
        files.length === 0
          ? request.assetSlug
          : `${request.assetSlug}-f${files.length + 1}`;
      const path = `${dir}/${formatIndexedName(index, fileSlug, ext)}`;
      await downloadToLibrary(storage, ref.url, path, { fetchFn: callOptions.fetchFn });
      files.push(path);
      sidecar.outputs.push({ path, providerUrl: ref.url });
    }
    if (files.length === 0) {
      throw new ChatServiceError("Meshy 结果中没有可下载文件", 502, "meshy_no_files");
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    return { files, sidecar: sidecarPath, meshyTaskId: taskId };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

// ---------- Mastra tool 包装（付费操作，全部任务化：启动即返回，不阻塞对话） ----------

const CHANNEL_KEY_HINTS = {
  meshy: ["meshyApiKey", "缺少 Meshy API key（请用户在设置中填写）"],
  hunyuan: ["hunyuanApiKey", "缺少混元 API key（腾讯云「SecretId:SecretKey」，请用户在设置中填写）"],
  tripo: ["tripo3dApiKey", "缺少 Tripo3D API key（请用户在设置中填写）"],
} as const;

/** 渠道分发公共段：闸门 + 取对应渠道 key + 任务化 */
function startChanneledTask(
  context: unknown,
  channel: keyof typeof CHANNEL_KEY_HINTS,
  kind: MeshOperation,
  subject: string,
  run: (projectSlug: string, apiKey: string) => Promise<unknown>,
) {
  const projectSlug = requireCurrentProject(context as never);
  const [keyName, hint] = CHANNEL_KEY_HINTS[channel];
  const apiKey = requireContextString(context as never, keyName, hint);
  const task = startCustomTask(kind, projectSlug, subject, () =>
    run(projectSlug, apiKey),
  );
  return { task: { id: task.id, subject: task.subject, status: task.status } };
}

function startMeshOpTask(
  context: unknown,
  kind: MeshOperation,
  subject: string,
  toRequest: (projectSlug: string) => MeshOpRequest,
) {
  return startChanneledTask(context, "meshy", kind, subject, (projectSlug, apiKey) =>
    runMeshOperation(getAssetStorage(), toRequest(projectSlug), { apiKey }),
  );
}

export const retopologizeTool = createTool({
  id: "retopologize",
  description:
    "重拓扑/减面资产库中已有模型（付费操作——启动前须经用户同意）。渠道：meshy 默认（targetPolycount 精确面数）/ hunyuan（faceLevel 档位，模型经公网 URL）。生成新模型时的重拓扑可改用 start-3d-batch 的 hunyuan LowPoly。任务化返回",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    channel: z.enum(["meshy", "hunyuan"]).default("meshy"),
    targetPolycount: z.number().int().min(100).max(300000).default(30000),
    topology: z.enum(["quad", "triangle"]).default("triangle"),
    /** hunyuan 专用：目标面数档位 */
    faceLevel: z.enum(["high", "medium", "low"]).optional(),
  }),
  execute: async (input, context) => {
    if (input.channel === "hunyuan") {
      return startChanneledTask(context, "hunyuan", "retopo", `重拓扑：${input.assetSlug}`, (projectSlug, apiKey) =>
        runHunyuanRetopo(
          getAssetStorage(),
          {
            projectSlug,
            assetSlug: input.assetSlug,
            faceLevel: input.faceLevel,
            polygonType: input.topology === "quad" ? "quadrilateral" : "triangle",
          },
          { apiKey },
        ),
      );
    }
    return startMeshOpTask(context, "retopo", `重拓扑：${input.assetSlug}`, (projectSlug) => ({
      projectSlug,
      assetSlug: input.assetSlug,
      path: MESHY_PATHS.remesh,
      modelField: "model_url",
      body: {
        target_polycount: input.targetPolycount,
        topology: input.topology,
      },
      sidecarParams: {
        target_polycount: input.targetPolycount,
        topology: input.topology,
      },
    }));
  },
});

export const rigModelTool = createTool({
  id: "rig-model",
  description:
    "为资产库中已有模型绑骨蒙皮（付费操作——启动前须经用户同意）。渠道：meshy 默认（人形，收本地模型）/ hunyuan（A/T-pose 人形，模型经公网 URL，可带 1–48 预设动画编号）/ tripo（支持四足/禽类等 rigType，非 Tripo 资产自动导入）。超过 30 万面先 retopologize。任务化返回，成功后可接 generate-animation",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    channel: z.enum(["meshy", "hunyuan", "tripo"]).default("meshy"),
    /** meshy 专用：角色身高（米），提升骨骼比例精度 */
    heightMeters: z.number().positive().max(10).optional(),
    /** hunyuan 专用：预设动画编号 1–48 */
    motionType: z.number().int().min(1).max(48).optional(),
    /** tripo 专用：骨架类型（默认人形） */
    rigType: z
      .enum(["biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic"])
      .optional(),
    /** tripo 专用：骨骼命名规范 */
    spec: z.enum(["tripo", "mixamo"]).optional(),
  }),
  execute: async (input, context) => {
    if (input.channel === "hunyuan") {
      return startChanneledTask(context, "hunyuan", "rig", `绑骨蒙皮：${input.assetSlug}`, (projectSlug, apiKey) =>
        runHunyuanRig(
          getAssetStorage(),
          { projectSlug, assetSlug: input.assetSlug, motionType: input.motionType },
          { apiKey },
        ),
      );
    }
    if (input.channel === "tripo") {
      return startChanneledTask(context, "tripo", "rig", `绑骨蒙皮：${input.assetSlug}`, (projectSlug, apiKey) =>
        runTripoRig(
          getAssetStorage(),
          { projectSlug, assetSlug: input.assetSlug, rigType: input.rigType, spec: input.spec },
          { apiKey },
        ),
      );
    }
    return startMeshOpTask(context, "rig", `绑骨蒙皮：${input.assetSlug}`, (projectSlug) => ({
      projectSlug,
      assetSlug: input.assetSlug,
      path: MESHY_PATHS.rigging,
      modelField: "model_url",
      body: {
        ...(input.heightMeters !== undefined
          ? { height_meters: input.heightMeters }
          : {}),
      },
      sidecarParams: {
        ...(input.heightMeters !== undefined
          ? { height_meters: input.heightMeters }
          : {}),
      },
    }));
  },
});

export const generateAnimationTool = createTool({
  id: "generate-animation",
  description:
    "生成动画（付费操作——启动前须经用户同意）。渠道二选一：meshy 默认（给已绑骨资产套动画库动作，需 actionId，依赖该资产先有成功的 rig-model 记录）/ hunyuan（文生动作 motionPrompt，输出带蒙皮网格的 FBX 动画，1–12 秒，不依赖绑骨记录）。任务化返回",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    channel: z.enum(["meshy", "hunyuan"]).default("meshy"),
    /** meshy 专用：动画库动作编号 */
    actionId: z.number().int().nonnegative().optional(),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional(),
    /** hunyuan 专用：动作的文字描述（≤128 字） */
    motionPrompt: z.string().max(128).optional(),
    /** hunyuan 专用：动画时长秒数 */
    duration: z.number().int().min(1).max(12).optional(),
  }),
  execute: async (input, context) => {
    if (input.channel === "hunyuan") {
      if (!input.motionPrompt) {
        throw new ChatServiceError(
          "hunyuan 渠道需要 motionPrompt（动作的文字描述）",
          400,
          "missing_motion_prompt",
        );
      }
      const motionPrompt = input.motionPrompt;
      return startChanneledTask(context, "hunyuan", "animation", `动作生成：${input.assetSlug}`, (projectSlug, apiKey) =>
        runHunyuanMotion(
          getAssetStorage(),
          { projectSlug, assetSlug: input.assetSlug, prompt: motionPrompt, duration: input.duration },
          { apiKey },
        ),
      );
    }
    if (input.actionId === undefined) {
      throw new ChatServiceError(
        "meshy 渠道需要 actionId（Meshy 动画库动作编号，用户未指定时先与用户确认）",
        400,
        "missing_action_id",
      );
    }
    const actionId = input.actionId;
    return startChanneledTask(
      context,
      "meshy",
      "animation",
      `动作生成：${input.assetSlug}#${actionId}`,
      async (projectSlug, apiKey) => {
        const storage = getAssetStorage();
        const rigTaskId = await findMeshyRigTaskId(storage, projectSlug, input.assetSlug);
        return runMeshOperation(
          storage,
          {
            projectSlug,
            assetSlug: input.assetSlug,
            path: MESHY_PATHS.animations,
            body: {
              rig_task_id: rigTaskId,
              action_id: actionId,
              ...(input.fps ? { operation_type: "change_fps", fps: input.fps } : {}),
            },
            sidecarParams: {
              rig_task_id: rigTaskId,
              action_id: actionId,
              ...(input.fps ? { fps: input.fps } : {}),
            },
          },
          { apiKey },
        );
      },
    );
  },
});
