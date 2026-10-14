import { TosClient } from "@volcengine/tos-sdk";
import { createBlenderApi } from "./api";
import { readServiceSettings } from "./config";
import { BlenderStore } from "./store";
import { BlenderScheduler } from "./scheduler";
import { SandboxSecrets } from "./secrets";
import { VolcanoSandboxes } from "./volcano";
import { TosObjects } from "./objects";
import { Checkpoints } from "./checkpoints";
import { ManagedExecutor } from "./executor";
import { BlenderJobs } from "./jobs";
import { BlenderArtifacts } from "./artifacts";
import { BlenderBatchRunner, volcanoPlanner } from "./batchRunner";

const settings = readServiceSettings(), store = new BlenderStore(settings.database, undefined, settings.budgets);
const secrets = new SandboxSecrets(settings.secret), executor = new ManagedExecutor(settings.target);
const objects = new TosObjects(new TosClient(settings.tos), settings.tos.bucket), jobs = new BlenderJobs(store), artifacts = new BlenderArtifacts(store, objects);
const modelKey = process.env.VOLC_KEY, model = process.env.BLENDER_AGENT_MODEL;
const runner = modelKey && model ? new BlenderBatchRunner(jobs, volcanoPlanner(modelKey, model), artifacts, executor, secrets) : undefined;
const scheduler = new BlenderScheduler(store, secrets, {
  sandboxes: new VolcanoSandboxes(settings.volcano), executor,
  checkpoints: new Checkpoints(store, objects), runner,
  publishExport: async (session, operation) => {
    const token = secrets.open(store.credentials(session.id, session.epoch), session.id, session.epoch).control;
    await artifacts.commit(session, operation, await executor.exportFile(session, token, operation.id));
  },
});
const app = createBlenderApi(store, scheduler, settings, runner ? jobs : undefined, artifacts, secrets);
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.BLENDER_SERVICE_PORT ?? 3907), fetch: app.fetch });
// Shutdown interrupts sent requests; durable receipts are reconciled by the next process.
async function shutdown() { scheduler.close(); await server.stop(true); await scheduler.drain(); store.close(); process.exit(0); }
process.once("SIGTERM", () => void shutdown()); process.once("SIGINT", () => void shutdown());
console.log("Blender durable API started on loopback; external watchdog required");
