import { fileToBase64 } from "./fileEncoding";
import { CHAT_BASE_URL, chatFetch, chatResponseError } from "./sse";

/** 与 chat/src/dto/library.ts、projectTools 的派生状态对齐的客户端类型 */

export interface ProjectSummary {
  slug: string;
  name: string;
  /** 当前生效的天空盒资产 slug（单例指针，非列表），无则未生成过 */
  currentSkybox?: string;
  /** 当前生效的 World 资产 slug（单例指针，非列表） */
  currentWorld?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetState {
  slug: string;
  identity?: {
    kind: "model" | "texture" | "animation" | "world" | "skybox" | "image" | "other";
    name: string;
    intent: string;
    createdAt: string;
    /** 生成该资产所用的参考图逻辑路径；CAD/逃生舱资产没有源图，为空数组 */
    sourceImages: string[];
  };
  files: string[];
  /** 生成当前最新模型代次的操作；用于区分多部件与同模型多格式。 */
  latestModelOperation?: string;
}

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface PlanStep {
  id: string;
  content: string;
  status: PlanStepStatus;
}

/** agent 的当前计划（plan.json，no-op 进度状态，执行者是 agent 本人） */
export interface ProjectPlan {
  schemaVersion: 1;
  revision?: number;
  revisionReason?: string;
  title?: string;
  steps: PlanStep[];
  updatedAt: string;
}

/** 三分量向量：位置 / 欧拉旋转（XYZ 序，弧度）/ 缩放，与 three.js Object3D 对齐 */
export type Vec3 = [number, number, number];

/** 单个资产在共享场景里的摆放（scene.json 的条目） */
export interface AssetTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

/**
 * 场景摆放（scene.json）：**只含用户在视口里用 gizmo 手动调过的资产**，按 assetSlug 索引。
 * 没有条目的资产由 `Viewport/scenePlacement.ts` 按创建顺序算网格默认位——默认摆位是派生的，
 * 不落盘，所以这份记录天然稀疏。
 */
export interface SceneLayout {
  transforms: Record<string, AssetTransform>;
  updatedAt: string;
}

export interface ProjectState {
  project: ProjectSummary;
  sources: string[];
  /** 由图片模型生成或编辑、专门用于 3D 生成的参考图，最新在前。 */
  generatedReferences: string[];
  hasAnalysis: boolean;
  plan?: ProjectPlan;
  scene?: SceneLayout;
  assets: AssetState[];
}

/** 资产库文件的 HTTP 地址（3D 视口只读本地文件，经 chat 静态服务） */
export function libraryUrl(logicalPath: string): string {
  return `${CHAT_BASE_URL}/api/library/${logicalPath}`;
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await chatFetch("/api/projects");
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to load projects (${response.status})`);
  }
  return ((await response.json()) as { projects: ProjectSummary[] }).projects;
}

export async function createProject(name: string): Promise<ProjectSummary> {
  const slug = `p-${Date.now().toString(36)}`;
  const response = await chatFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, slug }),
  });
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to create project (${response.status})`);
  }
  return ((await response.json()) as { project: ProjectSummary }).project;
}

export async function fetchProjectState(slug: string): Promise<ProjectState | null> {
  const response = await chatFetch(`/api/projects/${slug}/state`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to load project (${response.status})`);
  }
  return (await response.json()) as ProjectState;
}

/** 天空盒与 World 都可保存多个，但视口同一时间各只启用一个 */
export async function activateEnvironmentAsset(
  projectSlug: string,
  kind: "skybox" | "world",
  assetSlug: string | null,
): Promise<ProjectSummary> {
  const response = await chatFetch(`/api/projects/${projectSlug}/environment`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, assetSlug }),
  });
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to switch environment asset (${response.status})`);
  }
  return ((await response.json()) as { project: ProjectSummary }).project;
}

/** 视口/列表使用的扁平资产条目 */
export interface LibraryAsset {
  id: string;
  projectSlug: string;
  assetSlug: string;
  name: string;
  kind: string;
  /** 最新一代主产物模型文件逻辑路径，无则 null（glb/gltf/obj/fbx 均可） */
  modelPath: string | null;
  /** modelPath 的扩展名（小写），无 modelPath 时为 null */
  modelExt: string | null;
  /** obj 主文件的配套 .mtl 附属文件逻辑路径（原始文件名，未加索引前缀），无则 null */
  mtlPath: string | null;
  /** 最新一代高斯泼溅（spz）逻辑路径，无则 null（world 资产优先渲染它） */
  spzPath: string | null;
  /** 最新一代环境贴图逻辑路径；兼容 HDR/EXR 与图片模型编辑出的 PNG/JPG/WebP。 */
  hdrPath: string | null;
  /** 最新一代的全部模型文件（部件分割等一次生成多文件时 >1），逻辑路径 */
  modelPaths: string[];
  /** 生成该资产所用的参考图逻辑路径；CAD/逃生舱资产没有源图，为空数组 */
  sourceImages: string[];
  /** 该资产目录下全部可见产物文件名 */
  files: string[];
  /**
   * 列表缩略图逻辑路径。只有当磁盘上那张图对应的正是当前 modelPath 时才非 null——
   * 模型换代后旧图自动失效（见 thumbnailFileName），null 即"该渲一张新的"。
   */
  thumbPath: string | null;
  /** 资产身份创建时间；无 identity 时为 null（共享场景网格布局按此排序） */
  createdAt: string | null;
  /** 当前项目扫描代次；同路径 repair 后用于重新挂载错误边界并清除旧拒绝缓存。 */
  resourceRevision?: number;
}

/** 项目级天空盒是单例：显式当前项优先，旧项目无指针时采用最近创建的一项。 */
export function selectProjectSkybox(
  assets: LibraryAsset[],
  currentSkybox?: string,
): LibraryAsset | null {
  const skyboxes = assets.filter((asset) => asset.kind === "skybox" && asset.hdrPath);
  return skyboxes.find((asset) => asset.assetSlug === currentSkybox) ??
    skyboxes.reduce<LibraryAsset | null>((latest, asset) =>
      !latest || (asset.createdAt ?? "") > (latest.createdAt ?? "") ? asset : latest,
    null);
}

function latestByExt(files: string[], ext: string): string | null {
  let best: { index: number; name: string } | null = null;
  for (const name of files) {
    const match = /^(\d+)-.*\.([^.]+)$/.exec(name);
    if (match?.[2]?.toLowerCase() !== ext) continue;
    const index = Number(match[1]);
    // 同索引多个 spz 时优先 full-res
    if (
      !best ||
      index > best.index ||
      (index === best.index && name.includes("full") && !best.name.includes("full"))
    ) {
      best = { index, name };
    }
  }
  return best?.name ?? null;
}

function latestEnvironment(files: string[]): string | null {
  const supported = new Set(["hdr", "exr", "png", "jpg", "jpeg", "webp"]);
  let best: { index: number; name: string } | null = null;
  for (const name of files) {
    const match = /^(\d+)-.*\.([^.]+)$/.exec(name);
    if (!match || !supported.has(match[2]!.toLowerCase())) continue;
    const index = Number(match[1]);
    if (!best || index > best.index) best = { index, name };
  }
  return best?.name ?? null;
}

const MODEL_FILE_RE = /^(\d+)-.*\.(glb|gltf|obj|fbx)$/i;
const PART_SEGMENT_OPERATIONS = new Set(["v3/mesh/segment", "SubmitHunyuan3DPartJob"]);

/** 最新一代的全部模型文件（部件分割等一次生成多个部件时全部列出） */
function latestModelFiles(files: string[]): string[] {
  // 单趟收集 {name, index}，避免同一个文件名跑两遍正则（原先找 max 一遍、filter 一遍）
  let maxIndex = -1;
  const indexed: { name: string; index: number }[] = [];
  for (const name of files) {
    const match = MODEL_FILE_RE.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    indexed.push({ name, index });
    if (index > maxIndex) maxIndex = index;
  }
  if (maxIndex < 0) return [];
  return indexed.filter((entry) => entry.index === maxIndex).map((entry) => entry.name);
}

/** 最新一代的主产物模型文件（同索引优先 glb，与 chat 端 latestAssetModel 同取舍） */
function latestModel(files: string[]): { name: string; ext: string } | null {
  let best: { index: number; name: string; ext: string } | null = null;
  for (const name of files) {
    const match = MODEL_FILE_RE.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    const ext = match[2]!.toLowerCase();
    if (
      !best ||
      index > best.index ||
      (index === best.index && ext === "glb" && best.ext !== "glb")
    ) {
      best = { index, name, ext };
    }
  }
  return best;
}

/**
 * 缩略图落盘名跟着源产物走，与 chat 侧 `projectTools.ts` 的 `thumbnailFileName`
 * 必须同规则（跨模块的同一份约定，两边各写一次）：`3-chair.glb` → `.thumb-3-chair.png`，
 * 天空盒则是 `1-sky.hdr` → `.thumb-1-sky.png`。换代成 `4-chair.glb` 后名字自然对不上，
 * 不需要额外的时间戳/哈希做失效判定。
 */
function thumbnailFileName(modelFileName: string): string {
  return `.thumb-${modelFileName.replace(/\.[^.]+$/, "")}.png`;
}

/** 未加索引前缀、保留原始文件名的附属文件（模型导入的 .mtl 等），按后缀找 */
function findAuxFile(files: string[], ext: string): string | null {
  return files.find((f) => !/^\d+-/.test(f) && f.toLowerCase().endsWith(`.${ext}`)) ?? null;
}

/**
 * 从已取到的 ProjectState 派生扁平资产列表：不发请求，纯计算。
 * 调用方已经手上有 state（如 useProjectState）时应直接用这个，
 * 避免和 fetchLibraryAssets 内部再发一次一模一样的 fetchProjectState。
 */
export function deriveLibraryAssets(
  projectSlug: string,
  state: ProjectState,
  resourceRevision = 0,
): LibraryAsset[] {
  const assets: LibraryAsset[] = [];
  for (const asset of state.assets) {
    const visible = asset.files.filter((f) => !f.startsWith("."));
    const dir = `projects/${projectSlug}/assets/${asset.slug}`;
    const model = latestModel(visible);
    const modelFiles = latestModelFiles(visible);
    const isPartGeneration = PART_SEGMENT_OPERATIONS.has(asset.latestModelOperation ?? "");
    const spz = latestByExt(visible, "spz");
    const hdr = asset.identity?.kind === "skybox" ? latestEnvironment(visible) : null;
    const mtl = model?.ext === "obj" ? findAuxFile(visible, "mtl") : null;
    // 缩略图是隐藏文件（`.` 前缀），刻意不在 visible 里找——它不算资产产物。
    // 源产物取"这个资产拿什么渲缩略图"：模型资产是主产物模型，天空盒没有模型、
    // 渲的是贴了 HDR 的球，源就是那张环境贴图（与 thumbSourcePath 同一套取舍）
    const thumbSource = model?.name ?? hdr;
    const thumb = thumbSource ? thumbnailFileName(thumbSource) : null;
    assets.push({
      id: `${projectSlug}/${asset.slug}`,
      projectSlug,
      assetSlug: asset.slug,
      name: asset.identity?.name ?? asset.slug,
      kind: asset.identity?.kind ?? "other",
      modelPath: model ? `${dir}/${model.name}` : null,
      modelExt: model?.ext ?? null,
      mtlPath: mtl ? `${dir}/${mtl}` : null,
      spzPath: spz ? `${dir}/${spz}` : null,
      hdrPath: hdr ? `${dir}/${hdr}` : null,
      // 多格式输出（同一模型同时给 GLB/FBX/OBJ）只能渲染优选主文件；只有侧写明确
      // 标记为部件分割时，同索引的多个模型才是需要一起组成资产的独立部件。
      modelPaths: (isPartGeneration ? modelFiles : model ? [model.name] : []).map(
        (name) => `${dir}/${name}`,
      ),
      sourceImages: asset.identity?.sourceImages ?? [],
      files: visible,
      thumbPath: thumb && asset.files.includes(thumb) ? `${dir}/${thumb}` : null,
      createdAt: asset.identity?.createdAt ?? null,
      resourceRevision,
    });
  }
  return assets;
}

/** 独立扫描也要有代次：自检等调用方不经过 useProjectState 的 refreshKey。 */
let libraryScanRevision = 0;

/** 扫描当前项目的资产清单（磁盘即数据库：一切来自目录派生状态） */
export async function fetchLibraryAssets(projectSlug: string): Promise<LibraryAsset[]> {
  const state = await fetchProjectState(projectSlug);
  if (!state) return [];
  return deriveLibraryAssets(projectSlug, state, ++libraryScanRevision);
}

/** 上传自检截图（四视角合成 PNG，base64 不含 data: 前缀），返回落盘逻辑路径 */
export async function uploadInspection(
  projectSlug: string,
  assetSlug: string,
  inspectionId: string,
  dataBase64: string,
): Promise<string> {
  const response = await chatFetch(
    `/api/projects/${projectSlug}/assets/${assetSlug}/inspection`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionId, dataBase64 }),
    },
  );
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to upload inspection image (${response.status})`);
  }
  return ((await response.json()) as { path: string }).path;
}

/** 上传列表缩略图（离屏渲染的单视角 PNG，base64 不含 data: 前缀），返回落盘逻辑路径 */
export async function uploadThumbnail(
  projectSlug: string,
  assetSlug: string,
  sourceFile: string,
  dataBase64: string,
): Promise<string> {
  const response = await chatFetch(
    `/api/projects/${projectSlug}/assets/${assetSlug}/thumbnail`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceFile, dataBase64 }),
    },
  );
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to upload thumbnail (${response.status})`);
  }
  return ((await response.json()) as { path: string }).path;
}

/** 导入本地模型：主文件按索引规范落盘，附属文件（.mtl/.bin/贴图）保留原始文件名，注册成全新资产 */
export async function uploadModel(
  projectSlug: string,
  primary: File,
  auxFiles: File[] = [],
): Promise<{ assetSlug: string; path: string }> {
  const [dataBase64, aux] = await Promise.all([
    fileToBase64(primary),
    Promise.all(
      auxFiles.map(async (file) => ({
        fileName: file.name,
        dataBase64: await fileToBase64(file),
      })),
    ),
  ]);
  const response = await chatFetch(`/api/projects/${projectSlug}/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: primary.name, dataBase64, auxFiles: aux }),
  });
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to import model (${response.status})`);
  }
  return (await response.json()) as { assetSlug: string; path: string };
}

/** 删除资产：整个资产目录连同产物从磁盘移除，不可撤销（确认在调用方做） */
export async function deleteAsset(
  projectSlug: string,
  assetSlug: string,
): Promise<void> {
  const response = await chatFetch(
    `/api/projects/${projectSlug}/assets/${assetSlug}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to delete asset (${response.status})`);
  }
}

/**
 * 保存场景摆放：只提交这一轮动过的资产，服务端合并进现有 scene.json（不是整份覆盖）。
 * 调用方负责防抖——gizmo 拖拽期间每帧都有新值，不能每帧发一次请求。
 */
export async function saveSceneTransforms(
  projectSlug: string,
  transforms: Record<string, AssetTransform>,
): Promise<void> {
  const response = await chatFetch(`/api/projects/${projectSlug}/scene`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transforms }),
  });
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to save scene placement (${response.status})`);
  }
}

export const EXPORT_FORMATS = ["glb", "gltf", "obj"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  glb: "GLB",
  gltf: "glTF",
  obj: "OBJ",
};

/**
 * 批量导出：多个资产统一转成同一目标格式；后端只成功转出一个文件时原样返回该文件，
 * 否则打包成 zip——文件名一律从响应的 Content-Disposition 头读，不在前端猜测。
 */
export async function exportAssetsBatch(
  sources: string[],
  format: ExportFormat,
): Promise<{ blob: Blob; fileName: string }> {
  const response = await chatFetch("/api/library/export-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources, format }),
  });
  if (!response.ok) {
    throw await chatResponseError(response, `Batch export failed (${response.status})`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const fileName = match ? decodeURIComponent(match[1]!) : `export-${format}.zip`;
  return { blob: await response.blob(), fileName };
}
