import { Hono } from "hono";
import { z } from "zod";
import { withServerCredentials } from "../config";
import { SlugSchema } from "../dto/library";
import { searchFalModels } from "../models/fal";
import { getAssetStorage } from "../services/assetStorage";
import { startCustomTask } from "../services/tasks";
import {
  runFalWildcard,
  WildcardRunParamsSchema,
} from "../mastra/tools/falWildcard";

export const wildcardRoutes = new Hono();

const SearchRequestSchema = z.object({
  q: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
  falApiKey: z.string().min(1),
});

/** 发现段：免费查询 */
wildcardRoutes.post("/search", async (c) => {
  const req = SearchRequestSchema.parse(withServerCredentials(await c.req.json()));
  const models = await searchFalModels(req.q, {
    apiKey: req.falApiKey,
    limit: req.limit,
  });
  return c.json({ models });
});

const RunRequestSchema = WildcardRunParamsSchema.extend({
  projectSlug: SlugSchema,
  falApiKey: z.string().min(1),
});

/** 执行段：付费操作——调用方必须已向用户确认精确端点 */
wildcardRoutes.post("/run", async (c) => {
  const req = RunRequestSchema.parse(withServerCredentials(await c.req.json()));
  const task = startCustomTask(
    "wildcard",
    req.projectSlug,
    `Wildcard：${req.endpoint}`,
    () =>
      runFalWildcard(
        getAssetStorage(),
        {
          projectSlug: req.projectSlug,
          endpoint: req.endpoint,
          input: req.input,
          outputSlug: req.outputSlug,
        },
        { apiKey: req.falApiKey },
      ),
  );
  return c.json({ task }, 202);
});
