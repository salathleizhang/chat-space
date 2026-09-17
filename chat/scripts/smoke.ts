/**
 * 三平台真实调用冒烟脚本。仅在 SMOKE_PAID=1 时提交付费任务。
 * 产物写入临时目录，不触碰用户的 ~/Chatspace 工程。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSourceDir } from "../src/common/libraryPaths";
import { runArk3dImageTo3d } from "../src/mastra/tools/ark3dOps";
import { createProject } from "../src/mastra/tools/projectTools";
import { runReferenceImageGeneration } from "../src/mastra/tools/referenceImage";
import { runSeed3dImageTo3d } from "../src/mastra/tools/seed3dOps";
import { runTripoImageTo3d } from "../src/mastra/tools/tripoOps";
import { runWorldGeneration } from "../src/mastra/tools/worldGen";
import { LocalFileStorage } from "../src/services/assetStorage";

const paid = process.env.SMOKE_PAID === "1";
const keys = {
  volc: process.env.VOLC_KEY,
  tripo: process.env.TRIPO_KEY,
  world: process.env.WORLDLABS_KEY,
};

if (!paid) {
  console.log("未设置 SMOKE_PAID=1，未调用任何付费 API。");
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "chatspace-smoke-"));
const storage = new LocalFileStorage(root);
await createProject(storage, { name: "冒烟", slug: "smoke" });
console.log(`产物目录：${root}`);

const seedImage = `${projectSourceDir("smoke")}/0-seed.png`;
await storage.writeBytes(seedImage, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAKElEQVR4nO3NMQEAAAgDoK1/aM3g4QcFaCbtzek9AAAAAAAAAAAAgMsO4gABJ8bNhAAAAABJRU5ErkJggg==",
  "base64",
));

type Outcome = { name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
const outcomes: Outcome[] = [];
async function step(name: string, enabled: boolean, run: () => Promise<string>): Promise<boolean> {
  if (!enabled) {
    outcomes.push({ name, status: "SKIP", detail: "未配置对应平台的本机密钥" });
    return false;
  }
  try {
    const detail = await run();
    outcomes.push({ name, status: "PASS", detail });
    return true;
  } catch (error) {
    outcomes.push({
      name,
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

let seedreamImage: string | undefined;
await step("火山 Seedream", Boolean(keys.volc), async () => {
  const result = await runReferenceImageGeneration(
    storage,
    { projectSlug: "smoke", prompt: "a red apple on a plain white background", channel: "volcengine" },
    { volcengineApiKey: keys.volc },
  );
  seedreamImage = result.images[0];
  return result.images.join(", ");
});

await step("火山 Seed3D", Boolean(keys.volc), async () => {
  const result = await runSeed3dImageTo3d(
    storage,
    { projectSlug: "smoke", assetSlug: "seed3d-apple", image: seedImage, subdivisionLevel: "low" },
    { apiKey: keys.volc! },
  );
  return result.files.join(", ");
});

await step("火山 Hyper3D", Boolean(keys.volc), async () => {
  const result = await runArk3dImageTo3d(
    storage, "hyper3d-volc", "smoke", "hyper3d-apple", seedImage,
    { apiKey: keys.volc! },
  );
  return result.files.join(", ");
});

await step("火山 Hi3D", Boolean(keys.volc && seedreamImage), async () => {
  const result = await runArk3dImageTo3d(
    storage, "hi3d-volc", "smoke", "hi3d-apple", seedreamImage,
    { apiKey: keys.volc! },
  );
  return result.files.join(", ");
});

await step("Tripo3D", Boolean(keys.tripo), async () => {
  const result = await runTripoImageTo3d(
    storage,
    { projectSlug: "smoke", assetSlug: "tripo-apple", image: seedImage },
    { apiKey: keys.tripo! },
  );
  return result.files.join(", ");
});

await step("World Labs", Boolean(keys.world), async () => {
  const result = await runWorldGeneration(
    storage,
    { projectSlug: "smoke", prompt: "A small sunny courtyard with one tree" },
    { apiKey: keys.world! },
  );
  return result.files.join(", ");
});

for (const outcome of outcomes) {
  console.log(`${outcome.status.padEnd(4)} ${outcome.name}: ${outcome.detail}`);
}
process.exit(outcomes.some((outcome) => outcome.status === "FAIL") ? 1 : 0);
