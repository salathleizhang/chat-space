import { Hono } from "hono";
import { config } from "../config";
import { readBlenderCloudSettings } from "../models/blenderCloud";

export const blenderRoutes = new Hono();
/** Connection configuration only: never leaks either desktop or command credentials.
 * Configured does not mean the sandbox is alive. The blender-session tool probes it. */
blenderRoutes.get("/connection", (c) => {
  const cloud = readBlenderCloudSettings();
  return c.json({ enabled: config.blender.enabled, transport: cloud ? "cloud" : "local",
    instanceName: cloud?.instanceName ?? null, projectSlug: cloud?.projectSlug ?? null });
});
