import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { SlugSchema } from "../../dto/library";
import { getAssetStorage, type AssetStorage } from "../../services/assetStorage";
import { getProjectState } from "./projectTools";
import { requireCurrentProject } from "./requestContext";

/**
 * 参考图身份识别回路（免费）：本产品无文生图，所有模型都先有参考图再生成，
 * 因此参考图天然覆盖绝大多数资产（CAD/wildcard 例外，无源图）。当用户用外观
 * 描述而非名字指代资产、文本名录（system 消息里的「资产」列表，按创建时间
 * 新→旧排列）匹配不上时，用这个工具代替瞎猜 slug：候选 slug 由 agent 自己
 * 从名录/对话上下文里挑（优先最近创建/最近提到的几个），工具只做存在性与
 * 「有没有参考图」校验，不做筛选决策——避免和 app 侧的解析逻辑产生两份真相。
 * 与 inspect-asset 同款异步：本轮不返回图片，图片以带图的用户消息回传
 * （OpenAI 兼容协议的 tool 消息装不了图）。但比 inspect-asset 简单：参考图
 * 已经在磁盘上，app 不需要开视口渲染，直接读库回传即可。
 */

const MAX_CANDIDATES = 5;

export interface IdentifyCandidatesResult {
  assetSlugs: string[];
  skipped?: string[];
}

/** 核心校验：候选 slug 必须存在且有参考图，不做筛选决策（见头注） */
export async function resolveIdentifyCandidates(
  storage: AssetStorage,
  projectSlug: string,
  assetSlugs: string[],
): Promise<IdentifyCandidatesResult> {
  const state = await getProjectState(storage, projectSlug);
  const bySlug = new Map(state.assets.map((asset) => [asset.slug, asset]));

  const missing: string[] = [];
  const noReferenceImage: string[] = [];
  const resolved: string[] = [];
  for (const slug of assetSlugs) {
    const asset = bySlug.get(slug);
    if (!asset) {
      missing.push(slug);
      continue;
    }
    if (!asset.identity || asset.identity.sourceImages.length === 0) {
      noReferenceImage.push(slug);
      continue;
    }
    resolved.push(slug);
  }

  if (missing.length > 0) {
    throw new ChatServiceError(`资产不存在：${missing.join("、")}`, 404, "asset_not_found");
  }
  if (resolved.length === 0) {
    throw new ChatServiceError(
      `以下资产没有参考图（CAD 或逃生舱生成的资产没有源图）：${noReferenceImage.join("、")}，` +
        "无法用参考图确认身份，请改用 inspect-asset 或直接询问用户",
      409,
      "no_reference_image",
    );
  }

  return {
    assetSlugs: resolved,
    ...(noReferenceImage.length > 0 ? { skipped: noReferenceImage } : {}),
  };
}

export const identifyAssetTool = createTool({
  id: "identify-asset",
  description:
    `确认用户指的是哪个资产（免费）：当用户用外观/颜色/形状等描述而非名字指代资产，` +
    `导致你无法从当前资产名录（已按创建时间新→旧排列）确定 slug 时调用，不要凭猜测的 ` +
    `slug 直接执行操作。传入你怀疑的候选 assetSlug（拿不准就优先选名录里最靠前，即最近 ` +
    `创建的几个，最多 ${MAX_CANDIDATES} 个）。注意：本轮不会返回图片——工作台会以带图的 ` +
    `用户消息回传每个候选资产的参考图（标注 slug），收到后据此确认身份，再继续你原本要做的操作。`,
  inputSchema: z.object({
    assetSlugs: z.array(SlugSchema).min(1).max(MAX_CANDIDATES),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const storage = getAssetStorage();
    const result = await resolveIdentifyCandidates(storage, projectSlug, input.assetSlugs);
    return {
      requested: true,
      ...result,
      note: "已请求参考图。参考图将以带图的用户消息回传（每个候选资产一张，标注 slug），收到后据此确认身份，再继续你原本要做的操作。",
    };
  },
});
