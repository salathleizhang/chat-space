import { Hono } from "hono";
import { LIBRARY_DIRS, sessionFile } from "../common/libraryPaths";
import {
  SaveSessionRequestSchema,
  SessionIdSchema,
  SessionSchema,
  type Session,
  type SessionSummary,
} from "../dto/sessions";
import { SlugSchema } from "../dto/library";
import { getAssetStorage, readJson, writeJson } from "../services/assetStorage";

export const sessionRoutes = new Hono();

sessionRoutes.get("/", async (c) => {
  const projectSlug = c.req.query("project");
  const projectFilter = projectSlug ? SlugSchema.parse(projectSlug) : undefined;
  const storage = getAssetStorage();
  const files = await storage.list(LIBRARY_DIRS.sessions);
  const sessions: SessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const session = await readJson(
        storage,
        `${LIBRARY_DIRS.sessions}/${file}`,
        SessionSchema,
      );
      if (projectFilter && session.projectSlug !== projectFilter) continue;
      sessions.push({
        id: session.id,
        projectSlug: session.projectSlug,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
      });
    } catch {
      // 坏会话文件跳过，不影响列表
    }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json({ sessions });
});

sessionRoutes.get("/:id", async (c) => {
  const id = SessionIdSchema.parse(c.req.param("id"));
  const storage = getAssetStorage();
  const path = sessionFile(id);
  if (!(await storage.exists(path))) {
    return c.json({ error: { code: "not_found", message: `会话「${id}」不存在` } }, 404);
  }
  return c.json({ session: await readJson(storage, path, SessionSchema) });
});

sessionRoutes.put("/:id", async (c) => {
  const id = SessionIdSchema.parse(c.req.param("id"));
  const req = SaveSessionRequestSchema.parse(await c.req.json());
  const storage = getAssetStorage();
  const path = sessionFile(id);
  const now = new Date().toISOString();

  let createdAt = now;
  if (await storage.exists(path)) {
    createdAt = (await readJson(storage, path, SessionSchema)).createdAt;
  }
  const session: Session = {
    schemaVersion: 1,
    id,
    projectSlug: req.projectSlug,
    title: req.title,
    messages: req.messages,
    ...(req.plan ? { plan: req.plan } : {}),
    createdAt,
    updatedAt: now,
  };
  await writeJson(storage, path, SessionSchema, session);
  return c.json({ session });
});
