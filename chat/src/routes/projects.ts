import { Hono } from "hono";
import { z } from "zod";
import { formatIndexedName, nextIndex } from "../common/indexedFiles";
import { projectSourceDir } from "../common/libraryPaths";
import { slugifyOrFallback } from "../common/slug";
import {
  AssetMaterialSchema,
  AssetTransformSchema,
  SceneKeySchema,
  SlugSchema,
} from "../dto/library";
import { getAssetStorage } from "../services/assetStorage";
import {
  activateEnvironmentAsset,
  createProject,
  deleteAsset,
  getProjectState,
  importLocalModel,
  listProjects,
  requireProject,
  saveAssetThumbnail,
  writeSceneLayout,
} from "../mastra/tools/projectTools";
import { saveInspectionSheet, saveSceneInspectionSheet } from "../mastra/tools/inspectTools";
import { uploadedBytes } from "../services/uploads";

const uploadFields = { dataBase64: z.string().min(1).optional(), localPath: z.string().min(1).optional() };
const hasUpload = (value: { dataBase64?: string; localPath?: string }) => [value.dataBase64, value.localPath].filter(Boolean).length === 1;

export const projectRoutes = new Hono();

const UploadInspectionSchema = z.object({
  inspectionId: z.string().min(1),
  /** base64 编码的 PNG 检查图（不含 data: 前缀） */
  ...uploadFields,
}).refine(hasUpload, "必须提供文件数据或本地文件引用");

const UploadThumbnailSchema = z.object({
  /** 缩略图渲染自哪个模型产物（basename，如 `3-chair.glb`） */
  sourceFile: z.string().min(1),
  /** base64 编码的 PNG 缩略图（不含 data: 前缀） */
  ...uploadFields,
}).refine(hasUpload, "必须提供文件数据或本地文件引用");

const CreateProjectSchema = z.object({
  name: z.string().min(1),
  slug: SlugSchema.optional(),
});

const UploadSourceSchema = z.object({
  fileName: z.string().min(1),
  /** base64 编码的文件内容（不含 data: 前缀） */
  ...uploadFields,
}).refine(hasUpload, "必须提供文件数据或本地文件引用");

const SOURCE_EXT_RE = /\.(png|jpe?g|webp)$/i;

projectRoutes.post("/", async (c) => {
  const req = CreateProjectSchema.parse(await c.req.json());
  const project = await createProject(getAssetStorage(), req);
  return c.json({ project }, 201);
});

projectRoutes.get("/", async (c) => {
  return c.json({ projects: await listProjects(getAssetStorage()) });
});

projectRoutes.get("/:slug/state", async (c) => {
  const slug = SlugSchema.parse(c.req.param("slug"));
  return c.json(await getProjectState(getAssetStorage(), slug));
});

/**
 * 场景文档的局部更新：两张表都可选，各自按资产 slug 浅合并进现有 scene.json
 * （不是整份覆盖）。摆放由 gizmo 防抖提交，材质由右侧栏每次改完立即提交，
 * 两条链路共用同一个端点，因此共用服务端同一把文件锁。
 */
const SaveSceneSchema = z.object({
  /**
   * 只带这一轮动过的资产，键是**资产稳定 id**（不是 slug）——这样删除资产后用同名
   * slug 重建也不会命中旧记录（见 SCENE_SCHEMA_VERSION 的 v3 说明）。
   */
  transforms: z.record(SceneKeySchema, AssetTransformSchema).optional(),
  materials: z.record(SceneKeySchema, AssetMaterialSchema).optional(),
});

const ActivateEnvironmentSchema = z.object({
  kind: z.enum(["skybox", "world"]),
  /** null 表示恢复内置默认天空盒，或暂不启用任何 World */
  assetSlug: SlugSchema.nullable(),
});

/** 天空盒与 World 都是“可保存多个、一次启用一个”的环境资产 */
projectRoutes.put("/:slug/environment", async (c) => {
  const slug = SlugSchema.parse(c.req.param("slug"));
  const req = ActivateEnvironmentSchema.parse(await c.req.json());
  const project = await activateEnvironmentAsset(
    getAssetStorage(),
    slug,
    req.kind,
    req.assetSlug ?? undefined,
  );
  return c.json({ project });
});

/** 场景文档落盘：摆放（gizmo 调完防抖提交）与材质（右侧栏改完立即提交） */
projectRoutes.put("/:slug/scene", async (c) => {
  const slug = SlugSchema.parse(c.req.param("slug"));
  const req = SaveSceneSchema.parse(await c.req.json());
  const scene = await writeSceneLayout(getAssetStorage(), slug, {
    transforms: req.transforms,
    materials: req.materials,
  });
  return c.json({ scene });
});

projectRoutes.post("/:slug/sources", async (c) => {
  const slug = SlugSchema.parse(c.req.param("slug"));
  const req = UploadSourceSchema.parse(await c.req.json());
  const extMatch = SOURCE_EXT_RE.exec(req.fileName);
  if (!extMatch) {
    return c.json(
      { error: { code: "unsupported_image", message: "只支持 png/jpg/webp 源图" } },
      400,
    );
  }

  const storage = getAssetStorage();
  await requireProject(storage, slug);

  const sourceDir = projectSourceDir(slug);
  const index = nextIndex(await storage.list(sourceDir));
  const baseName = req.fileName.replace(SOURCE_EXT_RE, "");
  const fileSlug = slugifyOrFallback(baseName, "source");
  const ext = extMatch[1]!.toLowerCase();
  const path = `${sourceDir}/${formatIndexedName(index, fileSlug, ext)}`;

  await storage.writeBytes(path, await uploadedBytes(req));
  return c.json({ path }, 201);
});

const ModelAuxFileSchema = z.object({
  fileName: z.string().min(1),
  ...uploadFields,
}).refine(hasUpload, "必须提供文件数据或本地文件引用");

const UploadModelSchema = z.object({
  fileName: z.string().min(1),
  ...uploadFields,
  auxFiles: z.array(ModelAuxFileSchema).optional(),
}).refine(hasUpload, "必须提供文件数据或本地文件引用");

/** 本地模型导入：拖入视口/点击导入按钮，每次导入建一个全新资产 */
projectRoutes.post("/:slug/models", async (c) => {
  const projectSlug = SlugSchema.parse(c.req.param("slug"));
  const req = UploadModelSchema.parse(await c.req.json());
  const storage = getAssetStorage();
  await requireProject(storage, projectSlug);
  const result = await importLocalModel(storage, {
    projectSlug,
    fileName: req.fileName,
    bytes: await uploadedBytes(req),
    auxFiles: await Promise.all((req.auxFiles ?? []).map(async (aux) => ({
      fileName: aux.fileName,
      bytes: await uploadedBytes(aux),
    }))),
  });
  return c.json(result, 201);
});

/** 自检截图上传：app 视口渲染的四视角检查图落盘 assets/<asset>/inspections/ */
projectRoutes.post("/:slug/assets/:assetSlug/inspection", async (c) => {
  const projectSlug = SlugSchema.parse(c.req.param("slug"));
  const assetSlug = SlugSchema.parse(c.req.param("assetSlug"));
  const req = UploadInspectionSchema.parse(await c.req.json());
  const result = await saveInspectionSheet(getAssetStorage(), {
    projectSlug,
    assetSlug,
    inspectionId: req.inspectionId,
    bytes: await uploadedBytes(req),
  });
  return c.json(result, 201);
});

/** 整场景检查图上传：主视口按机位拍的图落盘 <project>/inspections/（不属于单个资产） */
projectRoutes.post("/:slug/inspection", async (c) => {
  const projectSlug = SlugSchema.parse(c.req.param("slug"));
  const req = UploadInspectionSchema.parse(await c.req.json());
  const result = await saveSceneInspectionSheet(getAssetStorage(), {
    projectSlug,
    inspectionId: req.inspectionId,
    bytes: await uploadedBytes(req),
  });
  return c.json(result, 201);
});

/** 删除资产：整个 assets/<asset>/ 目录连同产物一并移除（破坏性，确认由 app 侧负责） */
projectRoutes.delete("/:slug/assets/:assetSlug", async (c) => {
  const projectSlug = SlugSchema.parse(c.req.param("slug"));
  const assetSlug = SlugSchema.parse(c.req.param("assetSlug"));
  return c.json(await deleteAsset(getAssetStorage(), projectSlug, assetSlug));
});

/** 资产列表缩略图上传：app 端离屏渲染的单视角 PNG 落盘 assets/<asset>/.thumb-*.png */
projectRoutes.post("/:slug/assets/:assetSlug/thumbnail", async (c) => {
  const projectSlug = SlugSchema.parse(c.req.param("slug"));
  const assetSlug = SlugSchema.parse(c.req.param("assetSlug"));
  const req = UploadThumbnailSchema.parse(await c.req.json());
  const result = await saveAssetThumbnail(getAssetStorage(), {
    projectSlug,
    assetSlug,
    sourceFile: req.sourceFile,
    bytes: await uploadedBytes(req),
  });
  return c.json(result, 201);
});
