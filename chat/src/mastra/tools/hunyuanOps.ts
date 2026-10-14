import { CloudTaskPending } from "../../cloud/context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import { extractFileUrls } from "../../common/fileUrls";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
} from "../../common/indexedFiles";
import { assetDir } from "../../common/libraryPaths";
import {
  RequestSidecarSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import {
  callHunyuanAction,
  waitForHunyuanJob,
  type HunyuanCallOptions,
} from "../../models/hunyuan";
import {
  getAssetStorage,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { startCustomTask } from "../../services/tasks";
import { downloadToLibrary } from "./assetRepair";
import { resolveModelPublicUrl } from "./modelPublicUrl";
import { requireProject } from "./projectTools";
import {
  requireContextString,
  requireCurrentProject,
} from "./requestContext";

/** 腾讯混元只保留已有模型的 UV 展开能力。 */

export interface HunyuanOpResult {
  files: string[];
  sidecar: string;
  jobId: string;
}

export async function runHunyuanUvUnwrap(
  storage: AssetStorage,
  params: { projectSlug: string; assetSlug: string },
  callOptions: HunyuanCallOptions,
): Promise<HunyuanOpResult> {
  await requireProject(storage, params.projectSlug);
  const model = await resolveModelPublicUrl(
    storage,
    params.projectSlug,
    params.assetSlug,
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
    model: "SubmitHunyuanTo3DUVJob",
    params: {
      input_model_url: model.url,
      input_type: model.type,
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
    const submitted = await callHunyuanAction(
      "SubmitHunyuanTo3DUVJob",
      { File: { Url: model.url, Type: model.type } },
      callOptions,
    );
    const jobId = submitted.JobId;
    if (typeof jobId !== "string" || !jobId) {
      throw new ChatServiceError("Hunyuan submission response is missing JobId", 502, "hunyuan_request_failed");
    }
    sidecar.providerTaskId = jobId;
    sidecar.status = "running";
    await saveSidecar();

    const result = await waitForHunyuanJob(
      "DescribeHunyuanTo3DUVJob",
      jobId,
      callOptions,
    );
    const seen = new Set<string>();
    const files: string[] = [];
    for (const ref of extractFileUrls(result)) {
      if (seen.has(ref.url)) continue;
      seen.add(ref.url);
      const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(ref.url)?.[1]?.toLowerCase() ?? "bin";
      const fileSlug = files.length === 0
        ? params.assetSlug
        : `${params.assetSlug}-f${files.length + 1}`;
      const path = `${dir}/${formatIndexedName(index, fileSlug, ext)}`;
      await downloadToLibrary(storage, ref.url, path, { fetchFn: callOptions.fetchFn });
      files.push(path);
      sidecar.outputs.push({ path, providerUrl: ref.url });
    }
    if (files.length === 0) {
      throw new ChatServiceError("No downloadable files in the Hunyuan UV unwrapping result", 502, "hunyuan_no_files");
    }
    sidecar.status = "succeeded";
    await saveSidecar();
    return { files, sidecar: sidecarPath, jobId };
  } catch (err) {
    if (err instanceof CloudTaskPending) throw err;
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

export const unwrapUvTool = createTool({
  id: "unwrap-uv",
  description:
    "UV-unwrap the asset's latest model via Tencent Hunyuan (the only remaining Hunyuan capability; paid operation — user consent is required before starting). The model input needs an accessible provider URL. Returns a task",
  inputSchema: z.object({
    assetSlug: SlugSchema,
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const apiKey = requireContextString(
      context,
      "hunyuanApiKey",
      "HUNYUAN_KEY is not configured in the local chat/.env (format: SecretId:SecretKey)",
    );
    const task = startCustomTask(
      "uv",
      projectSlug,
      `UV unwrapping: ${input.assetSlug}`,
      () =>
        runHunyuanUvUnwrap(
          getAssetStorage(),
          { projectSlug, assetSlug: input.assetSlug },
          { apiKey },
        ),
      { assetSlug: input.assetSlug, cloudOperation: { operation: "uv", input } },
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});
