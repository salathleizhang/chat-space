import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { EyeIcon } from "@phosphor-icons/react/Eye";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { UploadSimpleIcon } from "@phosphor-icons/react/UploadSimple";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { triggerBlobDownload } from "../../shared/lib/download";
import {
  EXPORT_FORMAT_LABELS,
  EXPORT_FORMATS,
  exportAssetsBatch,
  type ExportFormat,
  type LibraryAsset,
} from "../../shared/lib/libraryApi";
import type { GenerationTask } from "../../shared/lib/workflowClient";
import { Badge, Button, Panel, Tooltip } from "../../shared/ui";
import type { SectionId } from "../Sidebar";
import { AssetTextureStrip } from "./AssetTextureStrip";
import { AssetThumbnail } from "./AssetThumbnail";
import { thumbnailSrc, type ThumbnailQueue } from "./useThumbnailQueue";

const MODEL_IMPORT_ACCEPT = ".glb,.gltf,.obj,.fbx,.mtl,.bin,.png,.jpg,.jpeg,.webp";

const EXPORT_FORMAT_OPTIONS = EXPORT_FORMATS.map((format) => ({
  value: format,
  label: EXPORT_FORMAT_LABELS[format],
}));

interface ModelListProps {
  projectSlug: string;
  section: SectionId;
  /** 当前项目全部资产（共享场景数据源，由上层统一拉取，见 useProjectState） */
  assets: LibraryAsset[];
  /** 页面级任务轮询的共享快照；列表不再维护第二份请求状态。 */
  tasks: GenerationTask[];
  /** 当前生效的天空盒资产 slug（单例指针），无则还没生成过 */
  currentSkybox?: string;
  /** 当前生效的 World 资产 slug；旧项目无指针时第一个世界视为当前 */
  currentWorld?: string;
  /** 当前聚焦（相机飞向）的资产 id，用于 scenes/tasks 分区的行高亮 */
  focusedId: string | null;
  /**
   * 当前选中的资产 id 集合（assets 分区的行高亮 + 导出对象）。选中态住在上层
   * `AppDashboard`，与 3D 视口里的点选共享同一份 —— 在场景里点中的模型，列表这边
   * 同一行也会亮起来，反之亦然。
   */
  selectedIds: ReadonlySet<string>;
  /** 单击资产行：选中（shift 为增减多选） */
  onSelectAsset: (asset: LibraryAsset, additive: boolean) => void;
  /** 点击列表空白处：清空选中 */
  onClearSelection: () => void;
  /** 双击资产行：相机飞到该资产在共享场景里的位置 */
  onFocus: (asset: LibraryAsset) => void;
  /** 双击资产行打开模型预览小窗 */
  onOpenPreview?: (asset: LibraryAsset) => void;
  /** 全局唯一的缩略图队列；渲染器挂在 Dashboard，切换分区也不会中断。 */
  thumbnails: ThumbnailQueue;
  /** 点击导入按钮选中本地模型文件（一批 File，可能含 .mtl/贴图附属文件） */
  onImportModel?: (files: File[]) => void;
  /** 右键菜单删除资产（二次确认已在菜单内完成，这里直接执行） */
  onDeleteAsset?: (asset: LibraryAsset) => Promise<void> | void;
  /** 失败的 3D 任务使用原规格重试，凭证由上层本次提供。 */
  onRetryTask?: (task: GenerationTask) => Promise<void> | void;
  /** 悬浮详情里的启用操作；默认天空盒以 null 表示 */
  onActivateEnvironment?: (
    kind: "skybox" | "world",
    assetSlug: string | null,
  ) => Promise<void> | void;
}

/**
 * 悬浮信息：资产名 + 各通道贴图预览。
 * 2026-07 去掉了 slug/kind 副标题与产物文件名 Badge 列表——那些是磁盘实现细节，
 * 资产行本身已经显示名字与格式副标题，悬浮卡只留贴图这件看不到的事。
 */
function AssetHoverCard({
  asset,
  active,
  activating,
  onActivate,
}: {
  asset: LibraryAsset;
  active: boolean;
  activating: boolean;
  onActivate?: () => void;
}) {
  const isEnvironment = asset.kind === "skybox" || asset.kind === "world";
  return (
    <div className="flex min-w-60 flex-col gap-2 py-1">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 truncate text-sm font-medium text-ink-strong">
          {asset.name}
        </span>
        {isEnvironment &&
          (active ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-subtle">
              <CheckCircleIcon size={15} weight="fill" />
              使用中
            </span>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={activating}
              onClick={onActivate}
            >
              {activating ? "启用中…" : "启用"}
            </Button>
          ))}
      </div>
      {asset.assetSlug === DEFAULT_SKYBOX_SLUG && (
        <span className="text-xs text-ink-subtle">内置默认环境，不占用资产目录</span>
      )}
      <AssetTextureStrip asset={asset} />
    </div>
  );
}

/** 还没生成过天空盒时的占位资产：视口回退用的 public/env/sky.exr */
const DEFAULT_SKYBOX_SLUG = "__default-skybox__";

/**
 * 默认天空盒的球形缩略图：与生成出来的天空盒长一个样，但它**不在资产库里**
 * （没有资产目录，缩略图无处落盘），所以离线预渲染成静态资源随 app 一起发。
 * 换 sky.exr 时重跑 `scripts/render-sky-thumb.ts` 一起换掉这张。
 */
const DEFAULT_SKYBOX_THUMB = "/env/sky-thumb.png";

function defaultSkyboxAsset(projectSlug: string): LibraryAsset {
  return {
    id: `${projectSlug}/${DEFAULT_SKYBOX_SLUG}`,
    projectSlug,
    assetSlug: DEFAULT_SKYBOX_SLUG,
    name: "默认天空盒",
    kind: "skybox",
    modelPath: null,
    modelExt: null,
    mtlPath: null,
    spzPath: null,
    hdrPath: null,
    modelPaths: [],
    sourceImages: [],
    files: ["sky.exr"],
    thumbPath: null,
    createdAt: null,
  };
}

/** 卡片副标题：天空盒没有模型产物，按 HDR 环境贴图后缀显示 */
function assetSubtitle(asset: LibraryAsset) {
  if (asset.kind === "skybox") {
    const ext = asset.hdrPath?.split(".").pop() ?? "exr";
    return `${ext.toUpperCase()} · skybox`;
  }
  const head = asset.modelExt ? asset.modelExt.toUpperCase() : "无可渲染产物";
  const parts = asset.modelPaths.length > 1 ? ` · ${asset.modelPaths.length} 个部件` : "";
  return `${head} · ${asset.kind}${parts}`;
}

const TASK_STATUS_LABEL: Record<GenerationTask["status"], string> = {
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
};

const TASK_PHASE_LABEL: Record<NonNullable<GenerationTask["phase"]>, string> = {
  queued: "排队中",
  generating: "生成中",
  downloading: "下载中",
  validating: "校验中",
  publishing: "发布中",
  completed: "已完成",
  failed: "失败",
};

export const ModelList = memo(function ModelList({
  projectSlug,
  section,
  assets,
  tasks,
  currentSkybox,
  currentWorld,
  focusedId,
  selectedIds,
  onSelectAsset,
  onClearSelection,
  onFocus,
  onOpenPreview,
  thumbnails,
  onImportModel,
  onDeleteAsset,
  onRetryTask,
  onActivateEnvironment,
}: ModelListProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportMenuPos, setExportMenuPos] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const exportButtonRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    asset: LibraryAsset;
    left: number;
    top: number;
    exportOpen: boolean;
    /** 删除是破坏性且不可撤销的，菜单内就地展开一行二次确认，不另开弹窗 */
    confirmDelete: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const menuOpen = exportMenuOpen || contextMenu !== null;
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      setExportMenuOpen(false);
      setContextMenu(null);
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [menuOpen]);

  function openContextMenu(event: React.MouseEvent, asset: LibraryAsset) {
    event.preventDefault();
    setContextMenu({
      asset,
      left: event.clientX,
      top: event.clientY,
      exportOpen: false,
      confirmDelete: false,
    });
  }

  async function handleContextDelete(asset: LibraryAsset) {
    if (deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      // 选中集合住在上层，删掉的资产从集合里摘掉一并由上层收拾（见 AppDashboard）
      await onDeleteAsset?.(asset);
      setContextMenu(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setContextMenu(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleRetryTask(task: GenerationTask) {
    if (!onRetryTask || retryingId) return;
    setRetryingId(task.id);
    setActionError(null);
    try {
      await onRetryTask(task);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryingId(null);
    }
  }

  async function handleContextExport(format: ExportFormat) {
    const modelPath = contextMenu?.asset.modelPath;
    if (!modelPath || exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      const { blob, fileName } = await exportAssetsBatch([modelPath], format);
      triggerBlobDownload(blob, fileName);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
      setContextMenu(null);
    }
  }

  async function handleActivate(asset: LibraryAsset) {
    if (
      activatingId ||
      (asset.kind !== "skybox" && asset.kind !== "world") ||
      !onActivateEnvironment
    ) {
      return;
    }
    setActivatingId(asset.id);
    setActionError(null);
    try {
      await onActivateEnvironment(
        asset.kind,
        asset.assetSlug === DEFAULT_SKYBOX_SLUG ? null : asset.assetSlug,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivatingId(null);
    }
  }

  function toggleExportMenu() {
    if (exportMenuOpen) {
      setExportMenuOpen(false);
      return;
    }
    const rect = exportButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setExportMenuPos({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    setExportMenuOpen(true);
  }

  async function handleBatchExport(format: ExportFormat) {
    const sources = exportableSelected.map((asset) => asset.modelPath!);
    if (sources.length === 0 || exporting) return;
    setExportMenuOpen(false);
    setExporting(true);
    setActionError(null);
    try {
      const { blob, fileName } = await exportAssetsBatch(sources, format);
      triggerBlobDownload(blob, fileName);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  const { skyboxAssets, worldAssets, regularAssets } = useMemo(() => {
    const skyboxes: LibraryAsset[] = [];
    const worlds: LibraryAsset[] = [];
    const regular: LibraryAsset[] = [];
    for (const asset of assets) {
      if (asset.kind === "skybox") skyboxes.push(asset);
      else if (asset.kind === "world") worlds.push(asset);
      else regular.push(asset);
    }
    return {
      skyboxAssets: skyboxes,
      worldAssets: worlds,
      regularAssets: regular,
    };
  }, [assets]);
  const defaultSkybox = useMemo(() => defaultSkyboxAsset(projectSlug), [projectSlug]);
  // 资产库顺序就是产品语义：全部天空盒在顶部、普通资产居中、全部 World 在最底部。
  // “场景”入口暂时保留，仍只列 World，未来可升级为真正的场景配置管理器。
  const visibleAssets = useMemo(
    () =>
      section === "assets"
        ? [defaultSkybox, ...skyboxAssets, ...regularAssets, ...worldAssets]
        : section === "scenes"
          ? worldAssets
          : [],
    [defaultSkybox, regularAssets, section, skyboxAssets, worldAssets],
  );
  const activeWorldSlug = currentWorld ?? worldAssets[0]?.assetSlug;
  const count = section === "tasks" ? tasks.length : visibleAssets.length;
  // 天空盒没有模型产物，选中它也不该点亮导出按钮
  const exportableSelected = useMemo(
    () => visibleAssets.filter((asset) => selectedIds.has(asset.id) && asset.modelPath),
    [selectedIds, visibleAssets],
  );

  return (
    <Panel className="flex max-h-[70vh] w-64 flex-col overflow-hidden">
      <div className="flex items-center justify-end border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] whitespace-nowrap text-ink-subtle">{count}</span>
          {section === "assets" && (
            <div ref={exportButtonRef}>
              <Tooltip content={exportableSelected.length === 0 ? "先选中要导出的模型" : "导出"}>
                <Button
                  variant={exportMenuOpen ? "secondary" : "ghost"}
                  shape="square"
                  size="sm"
                  icon={UploadSimpleIcon}
                  aria-label="导出"
                  disabled={exportableSelected.length === 0}
                  onClick={toggleExportMenu}
                />
              </Tooltip>
            </div>
          )}
          {section === "assets" && (
            <Tooltip content="导入本地模型">
              <Button
                variant="ghost"
                shape="square"
                size="sm"
                icon={DownloadSimpleIcon}
                aria-label="导入本地模型"
                onClick={() => fileInputRef.current?.click()}
              />
            </Tooltip>
          )}
        </div>
      </div>
      {section === "assets" &&
        exportMenuOpen &&
        exportMenuPos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setExportMenuOpen(false)} />
            <div
              style={{
                left: exportMenuPos.left,
                top: exportMenuPos.top,
                minWidth: Math.max(exportMenuPos.width, 176),
              }}
              className="fixed z-50 flex origin-top-left flex-col gap-1 rounded-surface border border-line bg-surface-raised p-2 shadow-lg backdrop-blur-md transition-[opacity,transform] duration-150 ease-spring starting:opacity-0 starting:scale-95 motion-reduce:starting:scale-100"
            >
              <span className="px-4 pt-2 pb-1 text-xs text-ink-subtle">
                已选 {exportableSelected.length} 个
              </span>
              {EXPORT_FORMAT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={exporting}
                  onClick={() => handleBatchExport(option.value as ExportFormat)}
                  className="flex h-[54px] w-full items-center truncate rounded-inset px-4 text-left text-sm text-ink transition-transform duration-150 ease-spring hover:bg-fill motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
                >
                  {exporting ? "导出中…" : option.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
      {contextMenu &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
            <div
              style={{ left: contextMenu.left, top: contextMenu.top }}
              className="fixed z-50 flex w-44 origin-top-left flex-col gap-1 rounded-surface border border-line bg-surface-raised p-2 shadow-lg backdrop-blur-md transition-[opacity,transform] duration-150 ease-spring starting:opacity-0 starting:scale-95 motion-reduce:starting:scale-100"
            >
              <button
                type="button"
                onClick={() =>
                  setContextMenu((prev) =>
                    prev
                      ? { ...prev, exportOpen: !prev.exportOpen, confirmDelete: false }
                      : prev,
                  )
                }
                className="flex h-[54px] w-full items-center justify-between gap-2 truncate rounded-inset px-4 text-left text-sm text-ink transition-transform duration-150 ease-spring hover:bg-fill motion-safe:active:scale-[0.97]"
              >
                导出
                <CaretRightIcon
                  size={14}
                  weight="regular"
                  className={`transition-transform duration-150 ease-spring ${
                    contextMenu.exportOpen ? "rotate-90" : ""
                  }`}
                />
              </button>
              {contextMenu.exportOpen && (
                <div className="flex flex-col gap-1 pl-2">
                  {EXPORT_FORMAT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={exporting}
                      onClick={() => handleContextExport(option.value as ExportFormat)}
                      className="flex h-[54px] w-full items-center truncate rounded-inset px-4 text-left text-sm text-ink transition-transform duration-150 ease-spring hover:bg-fill motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
                    >
                      {exporting ? "导出中…" : option.label}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  onOpenPreview?.(contextMenu.asset);
                  setContextMenu(null);
                }}
                className="flex h-[54px] w-full items-center gap-2 truncate rounded-inset px-4 text-left text-sm text-ink transition-transform duration-150 ease-spring hover:bg-fill motion-safe:active:scale-[0.97]"
              >
                <EyeIcon size={16} weight="regular" />
                预览
              </button>
              {/* 删除不可撤销：第一下只把这一行换成确认态，第二下才真删 */}
              <button
                type="button"
                disabled={deleting}
                onClick={() =>
                  contextMenu.confirmDelete
                    ? handleContextDelete(contextMenu.asset)
                    : setContextMenu((prev) =>
                        prev ? { ...prev, confirmDelete: true, exportOpen: false } : prev,
                      )
                }
                className={`flex h-[54px] w-full items-center gap-2 truncate rounded-inset px-4 text-left text-sm transition-transform duration-150 ease-spring motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 ${
                  contextMenu.confirmDelete
                    ? "bg-fill text-signal hover:bg-fill-active"
                    : "text-ink hover:bg-fill"
                }`}
              >
                <TrashIcon size={16} weight="regular" />
                {deleting ? "删除中…" : contextMenu.confirmDelete ? "确认删除" : "删除"}
              </button>
            </div>
          </>,
          document.body,
        )}
      {actionError && (
        <p className="border-b border-line px-4 py-2 text-xs text-ink">⚠️ {actionError}</p>
      )}
      {section === "assets" && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={MODEL_IMPORT_ACCEPT}
          className="hidden"
          onChange={(event) => {
            onImportModel?.(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      )}
      <div
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
        onClick={(event) => {
          if (section === "assets" && event.target === event.currentTarget) {
            onClearSelection();
          }
        }}
      >
        {section !== "tasks" &&
          (section === "scenes"
            ? worldAssets.length === 0
            : skyboxAssets.length + regularAssets.length + worldAssets.length === 0) && (
          <span className="px-3 py-2 text-xs text-ink-subtle">
            {section === "scenes"
              ? "还没有场景。上传一张图并生成干净底板后，可创建可探索世界。"
              : "还没有模型资产。上传一张图或直接描述想要的模型开始生成。"}
          </span>
        )}

        {section !== "tasks" &&
          visibleAssets.map((asset) => {
            const isAssetsSection = section === "assets";
            // 天空盒卡片规格与普通资产一致，但没有模型产物：
            // 不给预览/导出右键菜单，也没有删除入口（它是常驻卡片）
            const isSkybox = asset.kind === "skybox";
            const isEnvironment = isSkybox || asset.kind === "world";
            const isEnvironmentActive =
              (isSkybox &&
                (asset.assetSlug === DEFAULT_SKYBOX_SLUG
                  ? !currentSkybox
                  : asset.assetSlug === currentSkybox)) ||
              (asset.kind === "world" && asset.assetSlug === activeWorldSlug);
            const isRowSelected = isAssetsSection
              ? selectedIds.has(asset.id)
              : focusedId === asset.id;
            return (
            <div
              key={asset.id}
              className="flex flex-col transition-[opacity,transform] duration-300 ease-spring starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:translate-y-0"
            >
              <div className="flex items-center gap-1">
                {/* 这张悬浮卡会在气泡里加载整个模型抽贴图，必须等一个"确实想看"的
                    停留时间再弹，否则鼠标扫过列表就是逐行拉起模型下载 */}
                <Tooltip
                  side="right"
                  width="wide"
                  delay={250}
                  /* 贴图条排不下时要能横向滚，气泡必须收得到指针事件 */
                  interactive
                  className="min-w-0 flex-1"
                  content={
                    <AssetHoverCard
                      asset={asset}
                      active={isEnvironmentActive}
                      activating={activatingId === asset.id}
                      onActivate={
                        isEnvironment && !isEnvironmentActive
                          ? () => void handleActivate(asset)
                          : undefined
                      }
                    />
                  }
                >
                  <button
                    type="button"
                    onClick={(event) =>
                      isAssetsSection
                        ? onSelectAsset(asset, event.shiftKey)
                        : onFocus(asset)
                    }
                    onDoubleClick={
                      isSkybox
                        ? undefined
                        : () => (isAssetsSection ? onFocus(asset) : onOpenPreview?.(asset))
                    }
                    onContextMenu={
                      isAssetsSection && !isSkybox
                        ? (event) => openContextMenu(event, asset)
                        : undefined
                    }
                    className={`flex w-full items-center gap-3 rounded-inset px-3 py-2 text-left transition-colors ${
                      isRowSelected ? "bg-fill ring ring-line" : "hover:bg-fill"
                    }`}
                  >
                    <AssetThumbnail
                      asset={asset}
                      src={
                        asset.assetSlug === DEFAULT_SKYBOX_SLUG
                          ? DEFAULT_SKYBOX_THUMB
                          : thumbnailSrc(asset, thumbnails.generated)
                      }
                      pending={thumbnails.pendingIds.has(asset.id)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-sm text-ink">
                        {asset.name}
                      </span>
                      <span className="truncate text-xs text-ink-subtle">
                        {assetSubtitle(asset)}
                      </span>
                    </span>
                    {isEnvironmentActive && <Badge className="shrink-0">使用中</Badge>}
                  </button>
                </Tooltip>
              </div>
              {/* 共享场景里部件一律和主资产一起摆在同一个网格位置，
                  子行只做"飞到这个对象"，不再单独切换渲染哪个部件文件 */}
              {asset.modelPaths.length > 1 &&
                asset.modelPaths.map((path, i) => {
                  const fileName = path.split("/").pop() ?? path;
                  return (
                    <button
                      key={`${asset.id}#${i}`}
                      type="button"
                      onClick={() => onFocus(asset)}
                      className={`ml-4 flex w-[calc(100%-1rem)] items-center rounded-control px-3 py-1 text-left text-xs transition-colors ${
                        focusedId === asset.id
                          ? "bg-fill text-ink ring ring-line"
                          : "text-ink-subtle hover:bg-fill"
                      }`}
                    >
                      {fileName}
                    </button>
                  );
                })}
            </div>
            );
          })}

        {section === "tasks" && tasks.length === 0 && (
          <span className="px-3 py-2 text-xs text-ink-subtle">
            当前没有生成任务。
          </span>
        )}
        {section === "tasks" &&
          tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between gap-2 rounded-control px-3 py-2 hover:bg-fill"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-xs text-ink">{task.subject}</span>
                <span className="truncate text-[11px] text-ink-subtle">
                  {task.phase ? TASK_PHASE_LABEL[task.phase] : TASK_STATUS_LABEL[task.status]}
                  {task.status === "failed" && task.error ? ` · ${task.error}` : ""}
                </span>
              </span>
              {task.status === "failed" && task.retry && onRetryTask ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={retryingId !== null}
                  onClick={() => void handleRetryTask(task)}
                >
                  {retryingId === task.id ? "重试中…" : "重试"}
                </Button>
              ) : (
                <Badge>{TASK_STATUS_LABEL[task.status]}</Badge>
              )}
            </div>
          ))}
      </div>
    </Panel>
  );
});
