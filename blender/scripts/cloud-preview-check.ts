import { resolve } from "node:path";
import { BlenderCloudClient, readBlenderCloudSettings } from "../../chat/src/models/blenderCloud";
import { setBlenderMcp } from "../../chat/src/models/blenderMcp";
import { runBlenderExport } from "../../chat/src/mastra/tools/blenderOps";
import { LocalFileStorage } from "../../chat/src/services/assetStorage";
import { createProject } from "../../chat/src/mastra/tools/projectTools";

const settings = readBlenderCloudSettings();
if (!settings || settings.projectSlug !== "cloud-public-check") throw new Error("Missing cloud configuration for the standalone acceptance project");
const root = resolve(process.env.CHATSPACE_LIBRARY_DIR!);
const storage = new LocalFileStorage(root);
const client = new BlenderCloudClient(settings);
setBlenderMcp(client);
try {
  const status = await client.call("get_addon_status", {}, { timeoutMs: 30_000 });
  const facts = await client.call("get_object_info", { object_name: "CloudPublicProbe" });
  if (!await storage.exists(`projects/${settings.projectSlug}/project.json`)) {
    await createProject(storage, { name: "Cloud Blender integration acceptance", slug: settings.projectSlug });
  }
  const result = await runBlenderExport(storage, settings.projectSlug, {
    assetSlug: "cloud-probe-sphere", objectNames: ["CloudPublicProbe"],
  });
  await storage.writeTextAtomic("acceptance-result.json", JSON.stringify({
    instanceName: settings.instanceName, status: status.json, object: facts.json, export: result,
  }, null, 2));
  console.log(`Public GLB has entered the acceptance asset library: ${result.bytes} bytes, ${result.faces} triangles.`);
} finally {
  setBlenderMcp(null);
  await client.stop();
}
