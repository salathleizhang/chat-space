import { ChatServiceError } from "../../common/errors";
import {
  formatIndexedName,
  nextIndex,
  parseIndexedName,
  parseRequestSidecarName,
} from "../../common/indexedFiles";
import {
  LIBRARY_DIRS,
  projectAnalysisFile,
  projectAssetsDir,
  projectDir,
  projectFile,
  projectPlanFile,
  projectSceneFile,
  projectSourceDir,
  assetIdentityFile,
  assetDir,
} from "../../common/libraryPaths";
import { isSafeFileName } from "../../common/safeName";
import { slugifyOrFallback } from "../../common/slug";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  ProjectPlanSchema,
  ProjectSchema,
  RequestSidecarSchema,
  SCENE_SCHEMA_VERSION,
  SceneLayoutSchema,
  SlugSchema,
  assetStableId,
  migrateSceneLayout,
  type AssetIdentity,
  type AssetMaterial,
  type AssetTransform,
  type Project,
  type ProjectPlan,
  type SceneLayout,
} from "../../dto/library";
import {
  readJson,
  readJsonRaw,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { readCandidates } from "../../services/candidateRegistry";
import { publishGeneratedModel } from "../../services/modelPublishing";
import {
  extractWorldSemantics,
  type MarbleWorldResponse,
  type WorldSemantics,
} from "../../models/worldlabs";

export { slugify } from "../../common/slug";
import { slugify } from "../../common/slug";

export async function createProject(
  storage: AssetStorage,
  input: { name: string; slug?: string },
): Promise<Project> {
  const slug = input.slug ?? slugify(input.name);
  SlugSchema.parse(slug);
  if (await storage.exists(projectFile(slug))) {
    throw new ChatServiceError(`Project "${slug}" already exists`, 409, "project_exists");
  }
  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: 1,
    slug,
    name: input.name,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(storage, projectFile(slug), ProjectSchema, project);
  return project;
}

export async function requireProject(
  storage: AssetStorage,
  slug: string,
): Promise<Project> {
  if (!(await storage.exists(projectFile(slug)))) {
    throw new ChatServiceError(`Project "${slug}" does not exist`, 404, "project_not_found");
  }
  return readJson(storage, projectFile(slug), ProjectSchema);
}

/** 同一份元数据的读改写必须串行；不同文件互不阻塞。 */
const metadataMutationTails = new Map<string, Promise<unknown>>();

function withMetadataMutationLock<T>(
  storage: AssetStorage,
  path: string,
  mutate: () => Promise<T>,
): Promise<T> {
  if (storage.withLock) return storage.withLock(path, mutate);
  const previous = metadataMutationTails.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutate);
  metadataMutationTails.set(path, current);
  return current.finally(() => {
    if (metadataMutationTails.get(path) === current) {
      metadataMutationTails.delete(path);
    }
  });
}

function mutateProject(
  storage: AssetStorage,
  projectSlug: string,
  mutate: (project: Project) => Project | undefined | Promise<Project | undefined>,
): Promise<Project> {
  return withMetadataMutationLock(storage, projectFile(projectSlug), async () => {
    const project = await requireProject(storage, projectSlug);
    const updated = await mutate(project);
    if (!updated) return project;
    await writeJson(storage, projectFile(projectSlug), ProjectSchema, updated);
    return updated;
  });
}

type EnvironmentKind = "skybox" | "world";

function updateEnvironmentPointer(
  project: Project,
  kind: EnvironmentKind,
  assetSlug?: string,
): Project {
  const key = kind === "skybox" ? "currentSkybox" : "currentWorld";
  const updated = { ...project, updatedAt: new Date().toISOString() };
  if (assetSlug) updated[key] = assetSlug;
  else delete updated[key];
  return updated;
}

/** 切换项目当前天空盒指针：资产可有多个，但视口一次只启用一个 */
export function setCurrentSkybox(
  storage: AssetStorage,
  projectSlug: string,
  skyboxSlug?: string,
): Promise<Project> {
  return mutateProject(storage, projectSlug, (project) =>
    updateEnvironmentPointer(project, "skybox", skyboxSlug),
  );
}

/** 切换项目当前 World 指针（项目可有多个世界，视口一次只启用一个） */
export function setCurrentWorld(
  storage: AssetStorage,
  projectSlug: string,
  worldSlug?: string,
): Promise<Project> {
  return mutateProject(storage, projectSlug, (project) =>
    updateEnvironmentPointer(project, "world", worldSlug),
  );
}

/**
 * 工作台切换天空盒/World 的入口：默认天空盒用 undefined 表示；真实资产必须存在且
 * kind 匹配，避免 project.json 留下一根指向不存在或错误类型资产的悬空指针。
 */
export function activateEnvironmentAsset(
  storage: AssetStorage,
  projectSlug: string,
  kind: EnvironmentKind,
  assetSlug?: string,
): Promise<Project> {
  return mutateProject(storage, projectSlug, async (project) => {
    if (assetSlug) {
      const identityPath = assetIdentityFile(projectSlug, assetSlug);
      if (!(await storage.exists(identityPath))) {
        throw new ChatServiceError(`Asset "${assetSlug}" does not exist`, 404, "asset_not_found");
      }
      const identity = await readJson(storage, identityPath, AssetIdentitySchema);
      if (identity.kind !== kind) {
        throw new ChatServiceError(
          `Asset "${assetSlug}" is not a ${kind === "skybox" ? "skybox" : "world"} asset`,
          409,
          "asset_kind_mismatch",
        );
      }
    }
    return updateEnvironmentPointer(project, kind, assetSlug);
  });
}

export async function listProjects(storage: AssetStorage): Promise<Project[]> {
  const slugs = await storage.list(LIBRARY_DIRS.projects);
  const projects: Project[] = [];
  for (const slug of slugs) {
    if (await storage.exists(projectFile(slug))) {
      projects.push(await readJson(storage, projectFile(slug), ProjectSchema));
    }
  }
  return projects;
}

export interface AssetState {
  slug: string;
  identity?: AssetIdentity;
  files: string[];
  nextIndex: number;
  /** 生成当前最新模型代次的操作；app 用它区分“多部件”与“同模型多格式”。 */
  latestModelOperation?: string;
  /**
   * world 资产的渲染对齐参数（来自 `N-<slug>.json` 的 semantics_metadata）。
   * World Labs 的坐标系是 +Y 朝下，app 必须靠它把泼溅和 collider 一起翻正。
   */
  worldSemantics?: WorldSemantics;
}

export interface ProjectState {
  project: Project;
  sources: string[];
  /**
   * 只含 referenceImage 工具生成/编辑成功的 3D 参考图；`generatedAt` 是侧写的创建
   * 时刻（ISO）。**工作台要靠它判断"这张图是不是本会话产生的"**——只列路径的话，
   * 界面只能靠"第一次扫到它"猜，而项目状态会在每个后台任务落盘时重扫，猜错就把
   * 上一轮会话的参考图倒进新会话（见 useReferenceImageSurfacing 头注）。
   */
  generatedReferences: { path: string; generatedAt: string }[];
  nextSourceIndex: number;
  hasAnalysis: boolean;
  /** agent 的当前计划（plan.json，无则省略） */
  plan?: ProjectPlan;
  /** 用户在视口里手动调过的资产摆放（scene.json，稀疏，无则省略） */
  scene?: SceneLayout;
  assets: AssetState[];
}

const MODEL_OUTPUT_EXTENSIONS = new Set(["glb", "gltf", "obj", "fbx"]);

/**
 * 同一个索引下出现多个模型文件并不一定代表多个部件：供应商经常同时返回
 * GLB/FBX/OBJ 三种格式。只有生成这代文件的侧写明确是分段操作时，app 才应该
 * 把同索引模型一起放进场景。这里把最小必要语义随项目状态送出去，避免前端猜文件名。
 */
async function latestModelOperation(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  files: string[],
): Promise<string | undefined> {
  let latestModelIndex = -1;
  for (const name of files) {
    const parsed = parseIndexedName(name);
    if (parsed && MODEL_OUTPUT_EXTENSIONS.has(parsed.ext.toLowerCase())) {
      latestModelIndex = Math.max(latestModelIndex, parsed.index);
    }
  }
  if (latestModelIndex < 0) return undefined;

  const sidecarName = files.find(
    (name) => parseRequestSidecarName(name)?.index === latestModelIndex,
  );
  if (!sidecarName) return undefined;
  try {
    const sidecar = await readJson(
      storage,
      `${assetDir(projectSlug, assetSlug)}/${sidecarName}`,
      RequestSidecarSchema,
    );
    return sidecar.status === "succeeded" ? sidecar.model : undefined;
  } catch {
    // 老项目可能带有旧版或损坏侧写。状态扫描仍应可用，只是退化为主模型单文件。
    return undefined;
  }
}

/** 派生状态完全来自目录扫描——磁盘即数据库（决策 2） */
/**
 * 读世界响应里最新的那代 JSON，取出渲染对齐参数。
 *
 * 世界响应是供应商原样落盘的 blob（`N-<assetSlug>.json`），这里只读语义元数据那一段。
 * 读不到就不给 app 字段，由 app 用同一套缺省值兜底（缺省 flipY=true 是关键，见
 * models/worldlabs.ts 的 extractWorldSemantics）。
 */
async function readWorldSemantics(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  files: string[],
): Promise<WorldSemantics | undefined> {
  let latest: { name: string; index: number } | undefined;
  for (const name of files) {
    const match = /^(\d+)-(.+)\.json$/.exec(name);
    if (!match || match[2] !== assetSlug) continue;
    const index = Number(match[1]);
    if (!latest || index > latest.index) latest = { name, index };
  }
  if (!latest) return undefined;
  try {
    const response = JSON.parse(
      await storage.readText(`${assetDir(projectSlug, assetSlug)}/${latest.name}`),
    ) as MarbleWorldResponse;
    return extractWorldSemantics(response);
  } catch {
    // 损坏或半截的世界 JSON 不该拖垮整个项目状态：app 会退回缺省值。
    return undefined;
  }
}

export async function getProjectState(
  storage: AssetStorage,
  slug: string,
): Promise<ProjectState> {
  const project = await requireProject(storage, slug);
  const sources = await storage.list(projectSourceDir(slug));
  const assetSlugs = await storage.list(projectAssetsDir(slug));

  const assets: AssetState[] = [];
  /**
   * slug → 稳定 id，供 scene.json 的迁移就地复用（避免再读一遍所有 asset.json）。
   * **只要 asset.json 在就登记**，包括下面会被跳过的"空 model 身份"——那种资产可能
   * 只是模型还没生成完，它的场景记录不该因此被当成孤儿丢掉。
   */
  const assetIds = new Map<string, string>();
  for (const assetSlug of assetSlugs) {
    const identityPath = assetIdentityFile(slug, assetSlug);
    // asset.json 是正式发布标记。生成工作目录即使已有侧写或半截下载，也不是资产。
    if (!(await storage.exists(identityPath))) continue;
    const files = await storage.list(assetDir(slug, assetSlug));
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    assetIds.set(assetSlug, assetStableId(identity, assetSlug));
    // 兼容旧版本曾经提前创建的空 model 身份：它们不满足正式资产契约。
    if (
      identity.kind === "model" &&
      !files.some((name) => /\.(?:glb|gltf|obj|fbx)$/i.test(name))
    ) {
      continue;
    }
    const worldSemantics =
      identity.kind === "world"
        ? await readWorldSemantics(storage, slug, assetSlug, files)
        : undefined;
    assets.push({
      slug: assetSlug,
      identity,
      files,
      nextIndex: nextIndex(files),
      latestModelOperation: await latestModelOperation(storage, slug, assetSlug, files),
      ...(worldSemantics ? { worldSemantics } : {}),
    });
  }

  const generatedReferences: { index: number; path: string; generatedAt: string }[] = [];
  for (const fileName of sources) {
    if (!fileName.startsWith(".") || !fileName.endsWith("-request.json")) continue;
    try {
      const sidecar = await readJson(
        storage,
        `${projectSourceDir(slug)}/${fileName}`,
        RequestSidecarSchema,
      );
      const isReferenceRequest =
        typeof sidecar.params.count === "number" ||
        (typeof sidecar.params.asset_slug === "string" && !("role" in sidecar.params));
      if (!isReferenceRequest || sidecar.status !== "succeeded") continue;
      for (const output of sidecar.outputs) {
        if (/\.(?:png|jpe?g|webp)$/i.test(output.path)) {
          generatedReferences.push({
            index: sidecar.index,
            path: output.path,
            generatedAt: sidecar.createdAt,
          });
        }
      }
    } catch {
      // 旧版或损坏的侧写不是可靠的参考图来源，但不应拖垮整个项目状态。
    }
  }
  generatedReferences.sort((a, b) => b.index - a.index);

  const planPath = projectPlanFile(slug);
  const scenePath = projectSceneFile(slug);
  return {
    project,
    sources,
    generatedReferences: generatedReferences.map(({ path, generatedAt }) => ({
      path,
      generatedAt,
    })),
    nextSourceIndex: nextIndex(sources),
    hasAnalysis: await storage.exists(projectAnalysisFile(slug)),
    ...((await storage.exists(planPath))
      ? { plan: await readJson(storage, planPath, ProjectPlanSchema) }
      : {}),
    ...((await storage.exists(scenePath))
      ? { scene: await readSceneLayout(storage, scenePath, assetIds) }
      : {}),
    assets,
  };
}

/**
 * slug → 资产稳定 id。场景表按稳定 id 索引，而旧文件是按 slug 索引的，
 * 所以**每次读旧文档**和**迁移前的写入**都需要这张映射。
 *
 * 读不出来的 asset.json 按"没有 id"处理（退化成 `slug:<slug>`）：一个坏掉的身份文件
 * 不该让用户连摆放都存不下去。
 */
async function assetIdsBySlug(
  storage: AssetStorage,
  projectSlug: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const assetSlug of await storage.list(projectAssetsDir(projectSlug))) {
    const identityPath = assetIdentityFile(projectSlug, assetSlug);
    if (!(await storage.exists(identityPath))) continue;
    let identity: AssetIdentity | undefined;
    try {
      identity = await readJson(storage, identityPath, AssetIdentitySchema);
    } catch {
      identity = undefined;
    }
    ids.set(assetSlug, assetStableId(identity, assetSlug));
  }
  return ids;
}

/**
 * 读 scene.json 并收敛到当前版本。
 *
 * **不能用 `readJson(..., SceneLayoutSchema)`**：磁盘上可能是旧版本，当前 schema 直接
 * parse 会失败。所以先取原始 JSON，交给 `migrateSceneLayout` 迁移。迁移失败时补上
 * 路径与错误码——dto 层刻意不依赖 ChatServiceError。
 */
async function readSceneLayout(
  storage: AssetStorage,
  path: string,
  assetIds: ReadonlyMap<string, string>,
): Promise<SceneLayout> {
  const raw = await readJsonRaw(storage, path);
  try {
    return migrateSceneLayout(raw, assetIds);
  } catch (err) {
    throw new ChatServiceError(
      `Cannot migrate "${path}" to the current scene version: ${err instanceof Error ? err.message : String(err)}`,
      500,
      "scene_migration_failed",
    );
  }
}

/** scene.json 的一次局部更新：两张表都可选，各自按键浅合并 */
export interface ScenePatch {
  transforms?: Record<string, AssetTransform>;
  materials?: Record<string, AssetMaterial>;
}

/**
 * 合并式写入场景文档（scene.json）。与 `setCurrentSkybox` 同属"读 → patch → 整体写回"
 * 的局部更新式 mutator：app 侧一次只提交这轮动过的那几个资产，其余条目原样保留
 * ——视口里两个人（或两个窗口）先后拖不同的模型，后写的不该把先写的抹掉。
 *
 * scene.json 是一个读改写文档。把同一项目的所有变更串行化，否则两个窗口同时拖不同
 * 资产时可能都读到旧快照，后写入者会把先写入者整份覆盖。队尾即使失败也不能阻塞后续。
 * 摆放与材质共用一个锁：它们是同一份文件，分开加锁等于没加。
 */
export async function writeSceneLayout(
  storage: AssetStorage,
  projectSlug: string,
  patch: ScenePatch,
): Promise<SceneLayout> {
  const path = projectSceneFile(projectSlug);
  return withMetadataMutationLock(storage, path, async () => {
    await requireProject(storage, projectSlug);
    // 磁盘上可能是按 slug 索引的旧文档，所以读之前要先拿到稳定 id 映射
    const current = (await storage.exists(path))
      ? await readSceneLayout(storage, path, await assetIdsBySlug(storage, projectSlug))
      : null;
    const next: SceneLayout = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      revision: nextSceneRevision(current),
      transforms: { ...current?.transforms, ...patch.transforms },
      materials: { ...current?.materials, ...patch.materials },
      updatedAt: new Date().toISOString(),
    };
    await writeJson(storage, path, SceneLayoutSchema, next);
    return next;
  });
}

/**
 * 下一次写入的 revision：没有文档时是 1，否则自增。
 * 迁移自 v1 的文档 revision 是 0，所以它被新版本程序第一次改写后是 1。
 */
function nextSceneRevision(current: SceneLayout | null): number {
  return (current?.revision ?? 0) + 1;
}

/** 只提交摆放的调用方（gizmo 拖拽落盘、场景分析的测试夹具）走的窄入口 */
export async function writeSceneTransforms(
  storage: AssetStorage,
  projectSlug: string,
  transforms: Record<string, AssetTransform>,
): Promise<SceneLayout> {
  return writeSceneLayout(storage, projectSlug, { transforms });
}

/**
 * 资产删除后摘掉它的摆放与材质记录（按**稳定 id**，不是 slug）。
 *
 * 这一步现在是纯粹的**卫生清理**，不再是正确性的依赖：新资产拿到的是新 id，
 * 即使这里没跑成，旧记录它也读不到（见 `migrateSceneLayout` 的 v3 说明）。
 */
async function dropSceneEntries(
  storage: AssetStorage,
  projectSlug: string,
  assetId: string,
): Promise<void> {
  const path = projectSceneFile(projectSlug);
  await withMetadataMutationLock(storage, path, async () => {
    if (!(await storage.exists(path))) return;
    const scene = await readSceneLayout(storage, path, await assetIdsBySlug(storage, projectSlug));
    const hasTransform = assetId in scene.transforms;
    const hasMaterial = assetId in scene.materials;
    if (!hasTransform && !hasMaterial) return;
    const { [assetId]: _droppedTransform, ...transforms } = scene.transforms;
    const { [assetId]: _droppedMaterial, ...materials } = scene.materials;
    await writeJson(storage, path, SceneLayoutSchema, {
      ...scene,
      revision: nextSceneRevision(scene),
      transforms,
      materials,
      updatedAt: new Date().toISOString(),
    });
  });
}

const MODEL_EXT_RE = /^(glb|gltf|obj|fbx|stl)$/i;

/** 资产目录里最高索引的模型文件（同索引优先 glb）——各后处理能力的输入解析共用 */
export async function latestAssetModel(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
): Promise<string> {
  const dir = assetDir(projectSlug, assetSlug);
  let best: { index: number; name: string; isGlb: boolean } | null = null;
  for (const name of await storage.list(dir)) {
    const parsed = parseIndexedName(name);
    if (!parsed || !MODEL_EXT_RE.test(parsed.ext)) continue;
    const isGlb = parsed.ext.toLowerCase() === "glb";
    if (
      !best ||
      parsed.index > best.index ||
      (parsed.index === best.index && isGlb && !best.isGlb)
    ) {
      best = { index: parsed.index, name, isGlb };
    }
  }
  if (!best) {
    throw new ChatServiceError(
      `Asset "${assetSlug}" has no model file in its directory; generate a 3D model first`,
      409,
      "model_missing",
    );
  }
  return `${dir}/${best.name}`;
}

const IMPORT_MODEL_EXT_RE = /\.(glb|gltf|obj|fbx)$/i;

/** 资产目录下已有 slug 时追加 -2/-3……直到不冲突（每次导入都是新资产，不追加代次） */
export async function uniqueAssetSlug(
  storage: AssetStorage,
  projectSlug: string,
  base: string,
): Promise<string> {
  const existing = new Set(await storage.list(projectAssetsDir(projectSlug)));
  const candidates = await readCandidates(storage, projectSlug);
  for (const candidate of candidates.objects) existing.add(candidate.slug);
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export interface ImportModelAuxFile {
  fileName: string;
  bytes: Uint8Array;
}

export interface ImportModelParams {
  projectSlug: string;
  fileName: string;
  bytes: Uint8Array;
  auxFiles?: ImportModelAuxFile[];
}

export interface ImportModelResult {
  assetSlug: string;
  path: string;
}

/**
 * 用户本地模型导入（拖入视口/点击导入按钮）：每次导入建一个全新资产，不追加
 * 已有资产的代次。主文件按 `N-slug.ext` 规范重命名落盘（沿用现有索引扫描
 * 逻辑），附属文件（.mtl/.bin/贴图）保留原始文件名——OBJLoader/MTLLoader/
 * GLTFLoader 靠原始文件名解析 mtllib/map_Kd/gltf uri 等内部引用，重命名会
 * 打断引用；不重命名也不会和 `^\d+-` 前缀的索引扫描冲突（安全忽略）。
 */
export async function importLocalModel(
  storage: AssetStorage,
  params: ImportModelParams,
): Promise<ImportModelResult> {
  const extMatch = IMPORT_MODEL_EXT_RE.exec(params.fileName);
  if (!extMatch) {
    throw new ChatServiceError("Only glb/gltf/obj/fbx models are supported", 400, "unsupported_model");
  }
  for (const aux of params.auxFiles ?? []) {
    if (!isSafeFileName(aux.fileName)) {
      throw new ChatServiceError(
        `Invalid auxiliary file name: ${aux.fileName}`,
        400,
        "unsafe_filename",
      );
    }
  }

  const baseName = params.fileName.replace(IMPORT_MODEL_EXT_RE, "");
  const baseSlug = slugifyOrFallback(baseName, "model");
  const assetSlug = await uniqueAssetSlug(storage, params.projectSlug, baseSlug);
  const ext = extMatch[1]!.toLowerCase();
  const dir = assetDir(params.projectSlug, assetSlug);

  const path = `${dir}/${formatIndexedName(0, baseSlug, ext)}`;
  await storage.writeBytes(path, params.bytes);
  for (const aux of params.auxFiles ?? []) {
    await storage.writeBytes(`${dir}/${aux.fileName}`, aux.bytes);
  }
  await publishGeneratedModel(
    storage,
    params.projectSlug,
    {
      slug: assetSlug,
      name: baseName || assetSlug,
      intent: "Locally imported 3D model",
      sourceImages: [],
    },
    { files: [path] },
  );

  return { assetSlug, path };
}

/**
 * 缩略图对应的产物文件名格式（索引命名的可渲染产物）。
 * hdr/exr 是天空盒——它没有模型产物，app 端渲的是一个贴了该环境贴图的球。
 */
const STANDARD_THUMB_SOURCE_RE = /^\d+-[^/\\]*\.(glb|gltf|obj|fbx|hdr|exr)$/i;
const SKYBOX_RASTER_THUMB_SOURCE_RE = /^\d+-[^/\\]*\.(png|jpe?g|webp)$/i;

/**
 * 缩略图落盘名：`.thumb-<产物文件名去扩展名>.png`。
 * 以 `.` 开头（同 `.N-slug-request.json` 的侧写惯例）——派生状态的"可见产物"
 * 过滤会把它挡在 files 之外，不污染资产文件清单；名字跟着源产物走，模型换代
 * （`3-chair.glb` → `4-chair.glb`）后自然对不上，app 据此判定缩略图过期。
 */
export function thumbnailFileName(sourceFile: string): string {
  return `.thumb-${sourceFile.replace(/\.[^.]+$/, "")}.png`;
}

export interface SaveThumbnailParams {
  projectSlug: string;
  assetSlug: string;
  /** 缩略图渲染自哪个产物（basename，如 `3-chair.glb`、天空盒则是 `1-sky.hdr`） */
  sourceFile: string;
  bytes: Uint8Array;
}

/**
 * 资产列表缩略图落盘（app 端离屏渲染 → 本函数存盘 → 列表直接 <img> 引用）。
 * 服务端没有渲染能力，与自检截图同一套分工（见 inspectTools.ts）。
 */
export async function saveAssetThumbnail(
  storage: AssetStorage,
  params: SaveThumbnailParams,
): Promise<{ path: string }> {
  SlugSchema.parse(params.projectSlug);
  SlugSchema.parse(params.assetSlug);
  await requireProject(storage, params.projectSlug);
  let validSource = STANDARD_THUMB_SOURCE_RE.test(params.sourceFile);
  if (!validSource && SKYBOX_RASTER_THUMB_SOURCE_RE.test(params.sourceFile)) {
    const identityPath = assetIdentityFile(params.projectSlug, params.assetSlug);
    if (await storage.exists(identityPath)) {
      const identity = await readJson(storage, identityPath, AssetIdentitySchema);
      validSource = identity.kind === "skybox";
    }
  }
  if (!validSource) {
    throw new ChatServiceError(
      `Invalid thumbnail source output name: ${params.sourceFile}`,
      400,
      "invalid_thumbnail_source",
    );
  }
  if (params.bytes.length === 0) {
    throw new ChatServiceError("The thumbnail content is empty", 400, "empty_thumbnail");
  }
  const dir = assetDir(params.projectSlug, params.assetSlug);
  // 源产物必须真在磁盘上：挡住给不存在的模型写图（缩略图永远对应一个真实产物）
  if (!(await storage.exists(`${dir}/${params.sourceFile}`))) {
    throw new ChatServiceError(
      `Thumbnail source output does not exist: ${params.sourceFile}`,
      404,
      "thumbnail_source_missing",
    );
  }
  const path = `${dir}/${thumbnailFileName(params.sourceFile)}`;
  await storage.writeBytes(path, params.bytes);
  return { path };
}

/**
 * 删除整个资产（目录连同全部产物/侧写/缩略图一起移除，磁盘即数据库，删了就没了）。
 * 破坏性操作，只给工作台 HTTP API，不暴露给 Creator Agent。
 * 被删的正好是项目当前天空盒或 World 时顺手清掉单例指针，否则视口会加载不存在的文件。
 */
export async function deleteAsset(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
): Promise<{ deleted: string }> {
  SlugSchema.parse(projectSlug);
  SlugSchema.parse(assetSlug);
  await requireProject(storage, projectSlug);
  const dir = assetDir(projectSlug, assetSlug);
  if (!(await storage.exists(dir))) {
    throw new ChatServiceError(`Asset "${assetSlug}" does not exist`, 404, "asset_not_found");
  }
  // 先认身份再删目录：asset.json 一删，稳定 id 就无从得知，场景记录会变成清不掉的垃圾
  const identityPath = assetIdentityFile(projectSlug, assetSlug);
  const assetId = assetStableId(
    (await storage.exists(identityPath))
      ? await readJson(storage, identityPath, AssetIdentitySchema)
      : undefined,
    assetSlug,
  );
  await storage.remove(dir);
  await dropSceneEntries(storage, projectSlug, assetId);
  await mutateProject(storage, projectSlug, (project) => {
    if (
      project.currentSkybox !== assetSlug &&
      project.currentWorld !== assetSlug
    ) {
      return undefined;
    }
    const { currentSkybox: _skybox, currentWorld: _world, ...base } = project;
    return {
      ...base,
      ...(project.currentSkybox === assetSlug
        ? {}
        : { currentSkybox: project.currentSkybox }),
      ...(project.currentWorld === assetSlug
        ? {}
        : { currentWorld: project.currentWorld }),
      updatedAt: new Date().toISOString(),
    };
  });
  return { deleted: dir };
}

// 项目创建、列表、状态与删除属于工作台 HTTP API，不暴露给 Creator Agent。
export async function deleteEntry(
  storage: AssetStorage,
  logicalPath: string,
): Promise<void> {
  const parsed = LogicalPathSchema.parse(logicalPath);
  if (parsed === LIBRARY_DIRS.projects || parsed === LIBRARY_DIRS.sessions) {
    throw new ChatServiceError("Deleting a top-level asset library directory is not allowed", 400, "delete_refused");
  }
  await storage.remove(parsed);
}

export { projectDir };
