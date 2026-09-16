import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
} from "../../common/indexedFiles";
import { assetDir, assetIdentityFile } from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  RequestSidecarSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import {
  callFalQueue,
  extractFileRefs,
  searchFalModels,
  type FalCallOptions,
} from "../../models/fal";
import { writeJson, type AssetStorage } from "../../services/assetStorage";
import { downloadToLibrary } from "./assetRepair";
import { requireProject } from "./projectTools";
import { requireContextString } from "./requestContext";

/**
 * FAL 任意端点逃生舱（§4.7）：拆为发现（免费搜索）与执行（确认后）两段。
 * 执行是付费操作——调用方（UI/agent）必须在确认端点后才可调用 run。
 */

export const WildcardRunParamsSchema = z.object({
  projectSlug: SlugSchema,
  /** 用户确认过的精确端点 id，如 fal-ai/xxx/yyy */
  endpoint: z.string().regex(/^[\w-]+\/[\w./-]+$/, "端点格式形如 fal-ai/model/op"),
  /** 端点输入（按其 OpenAPI schema 构造；不得含密钥字段） */
  input: z.record(z.string(), z.unknown()),
  outputSlug: SlugSchema.default("wildcard"),
});
export type WildcardRunParams = z.infer<typeof WildcardRunParamsSchema>;

export interface WildcardRunResult {
  files: string[];
  sidecar: string;
  requestId: string;
  rawResult: unknown;
}

function extFromUrl(url: string, fallback: string): string {
  const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(url);
  return match ? match[1]!.toLowerCase() : fallback;
}

export async function runFalWildcard(
  storage: AssetStorage,
  rawParams: WildcardRunParams,
  callOptions: FalCallOptions,
): Promise<WildcardRunResult> {
  const params = WildcardRunParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);

  const dir = assetDir(params.projectSlug, params.outputSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, params.outputSlug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.outputSlug,
    provider: "fal",
    model: params.endpoint,
    params: { endpoint: params.endpoint, input: params.input },
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
    const { submission, result } = await callFalQueue(
      params.endpoint,
      params.input,
      callOptions,
      {
        onSubmit: async (s) => {
          sidecar.providerTaskId = s.requestId;
          sidecar.status = "running";
          await saveSidecar();
        },
      },
    );

    const refs = extractFileRefs(result);
    if (refs.length === 0) {
      throw new ChatServiceError(
        "端点结果中没有可下载文件（结果 JSON 已存入侧写）",
        502,
        "wildcard_no_files",
      );
    }
    const files: string[] = [];
    let seq = 0;
    for (const ref of refs) {
      seq += 1;
      const slug = seq === 1 ? params.outputSlug : `${params.outputSlug}-f${seq}`;
      const path = `${dir}/${formatIndexedName(index, slug, extFromUrl(ref.url, "bin"))}`;
      await downloadToLibrary(storage, ref.url, path, { fetchFn: callOptions.fetchFn });
      files.push(path);
      sidecar.outputs.push({ path, providerUrl: ref.url });
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    const identityPath = assetIdentityFile(params.projectSlug, params.outputSlug);
    if (!(await storage.exists(identityPath))) {
      await writeJson(storage, identityPath, AssetIdentitySchema, {
        schemaVersion: 1,
        slug: params.outputSlug,
        kind: "other",
        name: params.outputSlug,
        intent: `FAL wildcard: ${params.endpoint}`,
        sourceImages: [],
        createdAt: new Date().toISOString(),
      });
    }
    return { files, sidecar: sidecarPath, requestId: submission.requestId, rawResult: result };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

// ---------- Mastra tool 包装 ----------

/** 发现段：免费查询，agent 可自由调用 */
export const falWildcardSearchTool = createTool({
  id: "fal-wildcard-search",
  description:
    "在 FAL 平台按关键词搜索可用生成模型端点（免费查询）。返回候选端点清单；执行任何端点前必须先向用户确认，因为执行是付费操作",
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  execute: async (input, context) => {
    const apiKey = requireContextString(
      context,
      "falApiKey",
      "缺少 fal.ai API key（请用户在设置中填写）",
    );
    return { models: await searchFalModels(input.query, { apiKey, limit: input.limit }) };
  },
});
