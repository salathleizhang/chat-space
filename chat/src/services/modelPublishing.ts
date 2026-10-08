import { ChatServiceError } from "../common/errors";
import {
  assetDir,
  assetIdentityFile,
  projectTaskWorkDir,
} from "../common/libraryPaths";
import { AssetIdentitySchema, createAssetIdentity, type ReferenceImageViews } from "../dto/library";
import { readJson, writeJson, type AssetStorage } from "./assetStorage";
import { mutateCandidates } from "./candidateRegistry";

const RENDERABLE_MODEL_RE = /\.(?:glb|gltf|obj|fbx)$/i;

/** 并行模型完成时，candidates.json 的删项经统一串行 mutator，避免互相覆盖。 */
function removePublishedCandidate(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
): Promise<void> {
  return mutateCandidates(storage, projectSlug, (candidates) => {
    const objects = candidates.objects.filter((candidate) => candidate.slug !== assetSlug);
    if (objects.length === candidates.objects.length) return undefined;
    return { ...candidates, objects, updatedAt: new Date().toISOString() };
  }).then(() => undefined);
}

export interface GenerationObject {
  slug: string;
  name: string;
  intent: string;
  sourceImages: string[];
  referenceViews?: ReferenceImageViews;
}

class StagedAssetStorage implements AssetStorage {
  readonly withLock?: AssetStorage["withLock"];
  constructor(
    private readonly base: AssetStorage,
    private readonly finalDir: string,
    private readonly workDir: string,
  ) {
    if (base.withLock) this.withLock = (path, operation) => base.withLock!(this.map(path), operation);
  }

  private map(path: string): string {
    return path === this.finalDir || path.startsWith(`${this.finalDir}/`)
      ? `${this.workDir}${path.slice(this.finalDir.length)}`
      : path;
  }

  readText(path: string) { return this.base.readText(this.map(path)); }
  readBytes(path: string) { return this.base.readBytes(this.map(path)); }
  writeText(path: string, value: string) { return this.base.writeText(this.map(path), value); }
  writeTextAtomic(path: string, value: string) {
    return this.base.writeTextAtomic(this.map(path), value);
  }
  writeBytes(path: string, value: Uint8Array) {
    return this.base.writeBytes(this.map(path), value);
  }
  list(path: string) { return this.base.list(this.map(path)); }
  exists(path: string) { return this.base.exists(this.map(path)); }
  createExclusive(path: string, content: string) {
    return this.base.createExclusive(this.map(path), content);
  }
  remove(path: string) { return this.base.remove(this.map(path)); }
  move(sourcePath: string, targetPath: string) {
    if (!this.base.move) throw new Error("当前存储不支持原子发布");
    return this.base.move(this.map(sourcePath), this.map(targetPath));
  }
}

export function renderablePathsFromResult(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const record = result as { model?: unknown; files?: unknown };
  const candidates = [
    ...(typeof record.model === "string" ? [record.model] : []),
    ...(Array.isArray(record.files)
      ? record.files.filter((path): path is string => typeof path === "string")
      : []),
  ];
  return [...new Set(candidates.filter((path) => RENDERABLE_MODEL_RE.test(path)))];
}

/** asset.json 是正式资产的提交标记，只在可渲染产物完整落盘后写入。 */
export async function publishGeneratedModel(
  storage: AssetStorage,
  projectSlug: string,
  object: GenerationObject,
  result: unknown,
): Promise<void> {
  const models = renderablePathsFromResult(result);
  if (models.length === 0) {
    throw new ChatServiceError(
      `生成结果没有可被当前视口加载的模型：${object.slug}`,
      502,
      "renderable_model_missing",
    );
  }
  for (const path of models) {
    if (!(await storage.exists(path))) {
      throw new ChatServiceError(`生成产物尚未落盘：${path}`, 500, "model_not_landed");
    }
  }

  const identityPath = assetIdentityFile(projectSlug, object.slug);
  if (await storage.exists(identityPath)) {
    await readJson(storage, identityPath, AssetIdentitySchema);
    return;
  }
  await writeJson(
    storage,
    identityPath,
    AssetIdentitySchema,
    createAssetIdentity({
      slug: object.slug,
      kind: "model",
      name: object.name,
      intent: object.intent,
      sourceImages: object.sourceImages,
      ...(object.referenceViews ? { referenceViews: object.referenceViews } : {}),
    }),
  );
}

/** 新资产在 tasks/<id>/work 完整生成，成功后整目录原子发布；已有资产直接追加新代。 */
export async function runAndPublishGeneratedModel(
  storage: AssetStorage,
  projectSlug: string,
  taskId: string,
  object: GenerationObject,
  setPhase: (phase: "generating" | "validating" | "publishing") => Promise<void>,
  generate: (target: AssetStorage) => Promise<unknown>,
): Promise<unknown> {
  const finalDir = assetDir(projectSlug, object.slug);
  const alreadyPublished = await storage.exists(assetIdentityFile(projectSlug, object.slug));
  const workDir = projectTaskWorkDir(projectSlug, taskId);
  const target = alreadyPublished
    ? storage
    : new StagedAssetStorage(storage, finalDir, workDir);

  await setPhase("generating");
  const result = await generate(target);
  await setPhase("validating");
  await publishGeneratedModel(target, projectSlug, object, result);
  if (!alreadyPublished) {
    if (!storage.move) {
      throw new ChatServiceError("当前存储不支持原子发布资产", 500, "atomic_publish_unsupported");
    }
    await setPhase("publishing");
    await storage.move(workDir, finalDir);
    await removePublishedCandidate(storage, projectSlug, object.slug);
  }
  return result;
}
