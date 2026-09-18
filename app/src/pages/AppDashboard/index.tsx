import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AgentDock } from "../../widgets/AgentDock";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import {
  activateEnvironmentAsset,
  deleteAsset,
  uploadModel,
} from "../../shared/lib/libraryApi";
import { groupModelImportFiles } from "../../shared/lib/modelImport";
import {
  retryGenerationTask,
  type GenerationTask,
} from "../../shared/lib/workflowClient";
import { Button, Panel, Tooltip } from "../../shared/ui";
import { ImageGallery } from "../../widgets/ImageGallery";
import { ModelList } from "../../widgets/ModelList";
import { ThumbnailRenderer } from "../../widgets/ModelList/ThumbnailRenderer";
import { useThumbnailQueue } from "../../widgets/ModelList/useThumbnailQueue";
import { Sidebar, type SectionId } from "../../widgets/Sidebar";
import { Viewport } from "../../widgets/Viewport";
import { useAgentChat } from "./useAgentChat";
import { useChatMessages } from "./useChatMessages";
import { useProjectState } from "./useProjectState";
import { useSceneTransforms } from "./useSceneTransforms";
import { useSessionPersistence } from "./useSessionPersistence";
import { useTaskPolling } from "./useTaskPolling";

const ModelPreviewWindow = lazy(() =>
  import("../../widgets/ModelPreviewWindow").then((module) => ({
    default: module.ModelPreviewWindow,
  })),
);

/**
 * `/app/:projectSlug` — 单项目工作台。布局是全屏 Viewport 画布 + 悬浮面板
 * （左上 ModelList、左下 Sidebar、底部居中 AgentDock）；共享状态与业务编排
 * 拆到同目录的 hooks 里，本文件只负责状态组合与布局。
 */
export function AppDashboard() {
  const { projectSlug = "" } = useParams();

  /*
    React Router 会在 `/app/a` → `/app/b` 时复用同一个路由组件。业务工作台必须按项目
    重新挂载：选择、预览、摆位防抖、缩略图队列和任务轮询都属于项目级状态，不能只靠
    每个 hook 各自猜测何时清场。key 是这一层的总闸门；异步 hook 只需阻止组件卸载后
    已经在途的 Promise continuation 继续产生外部副作用。
  */
  return <ProjectDashboard key={projectSlug} projectSlug={projectSlug} />;
}

function ProjectDashboard({ projectSlug }: { projectSlug: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const initialImageFiles = (location.state as { initialImageFiles?: unknown } | null)?.initialImageFiles;
  const pendingImages = Array.isArray(initialImageFiles) && initialImageFiles.every((file) => file instanceof File)
    ? initialImageFiles as File[]
    : [];
  const launchConsumedRef = useRef(false);
  const [section, setSection] = useState<SectionId>("assets");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /**
   * 选中的资产集合，**由模型列表与 3D 视口共用**：在场景里点中的模型，列表同一行
   * 会亮起来；在列表里选中的模型，场景里会套上高亮包围盒；导出按钮统计的也是它。
   * 所以这份状态不能住在任一侧，只能提到这里。
   * 与 `focusedId` 是两件事：选中是"我在操作哪个"，聚焦是"相机看向哪个"（双击触发）。
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const focusAsset = useCallback((asset: LibraryAsset) => setFocusedId(asset.id), []);
  const selectAsset = useCallback((asset: LibraryAsset, additive: boolean) => {
    setSelectedIds((prev) => {
      if (!additive) return new Set([asset.id]);
      const next = new Set(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  }, []);
  // 已经是空集时返回原引用，避免每次点空白都造一个新 Set 触发无意义重渲染
  const clearSelection = useCallback(
    () => setSelectedIds((prev) => (prev.size === 0 ? prev : new Set())),
    [],
  );
  const removeSelectedAsset = useCallback((assetId: string) => {
    setSelectedIds((prev) => {
      if (!prev.has(assetId)) return prev;
      const next = new Set(prev);
      next.delete(assetId);
      return next;
    });
  }, []);

  const {
    projectName,
    projectError,
    plan,
    assets,
    referenceImages,
    currentSkybox,
    currentWorld,
    sceneTransforms,
  } = useProjectState(projectSlug, refreshKey);
  const selectedAssets = useMemo(
    () => assets.filter((asset) => selectedIds.has(asset.id)),
    [assets, selectedIds],
  );

  const {
    messages,
    setMessages,
    messagesRef,
    activity,
    setActivity,
    pushMessage,
    pushAssistant,
    updateMessage,
    appendTo,
    reportError,
  } = useChatMessages();

  const {
    activeSessionId,
    sessions,
    sessionsLoading,
    sessionsError,
    sessionReady,
    refreshSessions,
    switchSession,
    sessionPlan,
    setSessionPlan,
    startNewSession,
  } = useSessionPersistence(projectSlug, messages, setMessages);

  /** update-plan 的完整结果随 SSE 返回，直接成为当前会话快照；项目状态另行刷新。 */
  const handlePlanUpdated = useCallback(
    (updatedPlan: NonNullable<typeof plan>) => {
      setSessionPlan(updatedPlan);
      bumpRefresh();
    },
    [setSessionPlan, bumpRefresh],
  );

  // 摆位落盘失败以前只写状态行，会被下一个状态顶掉——用户摆的位置没存上，
  // 且事后完全查不到原因。走 reportError 让它同时留在对话里。
  const handleSceneSaveError = useCallback(
    (message: string) => reportError(`Failed to save placement: ${message}`),
    [reportError],
  );
  /** 视口 gizmo 调过的资产摆放：磁盘上的 scene.json 叠加本会话改动（乐观更新 + 防抖落盘） */
  const { transforms, commitTransforms, dropTransform, flushPendingSave } = useSceneTransforms(
    projectSlug,
    sceneTransforms,
    handleSceneSaveError,
  );

  const { tasks, pollTasks, onThumbnailGenerated } = useTaskPolling({
    projectSlug,
    enabled: sessionReady,
    assets,
    pushAssistant,
    updateMessage,
    setActivity,
    bumpRefresh,
  });

  const handleRetryTask = useCallback(
    async (task: GenerationTask) => {
      const retried = await retryGenerationTask(projectSlug, task.id);
      pollTasks([retried.id]);
    },
    [projectSlug, pollTasks],
  );
  const thumbnails = useThumbnailQueue({
    projectSlug,
    assets,
    refreshKey,
    onGenerated: onThumbnailGenerated,
  });

  const handleImportModel = useCallback(
    async (files: File[]) => {
      const groups = groupModelImportFiles(files);
      if (groups.length === 0) {
        reportError("No .glb, .gltf, .obj, or .fbx model files found");
        return;
      }
      const failures: string[] = [];
      let imported = 0;
      for (const [index, group] of groups.entries()) {
        try {
          setActivity({
            state: "working",
            message:
              groups.length === 1
                ? `Importing ${group.primary.name}`
                : `Importing ${index + 1}/${groups.length}: ${group.primary.name}`,
          });
          // 顺序导入是刻意的：同名文件依赖服务端 unique slug，完全并发会让两个请求
          // 同时看见同一个可用 slug。模型文件通常很大，顺序传输也避免多份 base64 峰值叠加。
          await uploadModel(projectSlug, group.primary, group.auxFiles);
          imported += 1;
        } catch (err) {
          failures.push(
            `${group.primary.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (imported > 0) {
        setActivity({
          state: "idle",
          message: groups.length === 1 ? `Imported ${groups[0]!.primary.name}` : `Imported ${imported} models`,
        });
        bumpRefresh();
      }
      if (failures.length > 0) reportError(`Some models could not be imported: \n${failures.join("\n")}`);
    },
    [projectSlug, bumpRefresh, setActivity, reportError],
  );

  const {
    preview,
    openPreview,
    closePreview,
    closePreviewFor,
    handleInspectionCaptured,
    send,
    stopStream,
    streaming,
  } = useAgentChat({
      projectSlug,
      sessionId: activeSessionId,
      sessionReady,
      messagesRef,
      pushMessage,
      pushAssistant,
      updateMessage,
      appendTo,
      setActivity,
      pollTasks,
      bumpRefresh,
      sessionPlan,
      onPlanUpdated: handlePlanUpdated,
    });

  useEffect(() => {
    if (!sessionReady || pendingImages.length === 0 || launchConsumedRef.current) return;
    launchConsumedRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
    send("", pendingImages);
  }, [location.pathname, navigate, pendingImages, send, sessionReady]);

  /**
   * 删除资产（ModelList 右键菜单，二次确认已在菜单内完成）：删盘 → 刷新共享场景数据源。
   * 顺手收拾指向这个资产的四处引用——相机聚焦 id、选中集合、正开着的预览小窗、本地摆位覆盖，
   * 否则 Viewport/小窗会盯着一个已经不在磁盘上的资产，导出按钮也会统计到幽灵资产，
   * 重新导入的同名资产（slug 复用）还会继承被删那个的摆位。
   * 失败往上抛，由 ModelList 就地显示错误条（与导出失败同一条提示路径）。
   */
  const handleDeleteAsset = useCallback(
    async (asset: LibraryAsset) => {
      // 先冲刷防抖快照并等摆位保存队列兑现：否则含该资产的 PUT 可能晚于 DELETE 到达，把已删资产摆位写回
      await flushPendingSave();
      await deleteAsset(projectSlug, asset.assetSlug);
      setFocusedId((current) => (current === asset.id ? null : current));
      setSelectedIds((prev) => {
        if (!prev.has(asset.id)) return prev;
        const next = new Set(prev);
        next.delete(asset.id);
        return next;
      });
      closePreviewFor(asset.id);
      dropTransform(asset.assetSlug);
      bumpRefresh();
    },
    [projectSlug, bumpRefresh, closePreviewFor, dropTransform, flushPendingSave],
  );

  /** 悬浮资产详情里的“启用”：天空盒与 World 各自维护一个项目级当前指针 */
  const handleActivateEnvironment = useCallback(
    async (kind: "skybox" | "world", assetSlug: string | null) => {
      await activateEnvironmentAsset(projectSlug, kind, assetSlug);
      bumpRefresh();
    },
    [projectSlug, bumpRefresh],
  );

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas text-ink">
      <Viewport
        assets={assets}
        focusedId={focusedId}
        selectedIds={selectedIds}
        currentSkybox={currentSkybox}
        currentWorld={currentWorld}
        transforms={transforms}
        onTransformCommit={commitTransforms}
        onSelectAsset={selectAsset}
        onClearSelection={clearSelection}
        onFocusAsset={focusAsset}
        onImportModel={handleImportModel}
      />
      <div className="absolute top-4 left-1/2 z-10 -translate-x-1/2 animate-chrome-enter">
        <Panel className="flex items-center gap-2 py-2 pr-4 pl-2">
          <Tooltip content="Leave current scene" side="bottom">
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={ArrowLeftIcon}
              aria-label="Leave current scene"
              onClick={() => navigate("/app")}
            />
          </Tooltip>
          <h1 className="max-w-[50vw] truncate text-sm font-medium text-ink-strong">
            {projectName || projectSlug}
          </h1>
        </Panel>
      </div>
      {projectError && (
        <Panel
          role="alert"
          className="absolute top-20 left-1/2 z-10 max-w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 px-4 py-2 text-xs text-ink"
        >
          ⚠️ {projectError}
        </Panel>
      )}
      <div className="absolute top-4 left-4 z-10 animate-chrome-enter">
        {section === "images" ? (
          <ImageGallery images={referenceImages} />
        ) : (
          <ModelList
            projectSlug={projectSlug}
            section={section}
            assets={assets}
            tasks={tasks}
            currentSkybox={currentSkybox}
            currentWorld={currentWorld}
            focusedId={focusedId}
            selectedIds={selectedIds}
            onSelectAsset={selectAsset}
            onClearSelection={clearSelection}
            onFocus={focusAsset}
            onOpenPreview={openPreview}
            thumbnails={thumbnails}
            onImportModel={handleImportModel}
            onDeleteAsset={handleDeleteAsset}
            onRetryTask={handleRetryTask}
            onActivateEnvironment={handleActivateEnvironment}
          />
        )}
      </div>
      {preview && (
        <div className="absolute top-4 right-4 z-20 animate-chrome-enter">
          <Suspense fallback={null}>
            <ModelPreviewWindow
              asset={preview.asset}
              inspection={preview.inspection}
              onClose={closePreview}
              onInspectionCaptured={handleInspectionCaptured}
            />
          </Suspense>
        </div>
      )}
      <div className="absolute bottom-4 left-4 z-10 animate-chrome-enter max-sm:top-36 max-sm:bottom-auto">
        <Sidebar active={section} onChange={setSection} />
      </div>
      <AgentDock
        messages={messages}
        activity={activity}
        streaming={streaming}
        onStop={stopStream}
        onNewSession={startNewSession}
        activeSessionId={activeSessionId}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        sessionsError={sessionsError}
        onOpenSessions={refreshSessions}
        onSelectSession={switchSession}
        onSend={send}
        selectedAssets={selectedAssets}
        onRemoveSelectedAsset={removeSelectedAsset}
        plan={sessionPlan}
        initiallyExpanded={pendingImages.length > 0}
      />
      {/* 放在 Dashboard 而不是资产列表里：用户切到图片/任务分区时，
          新 3D 模型仍能完成缩略图渲染并回填到对话。 */}
      {thumbnails.current &&
        createPortal(
          <ThumbnailRenderer asset={thumbnails.current} onCaptured={thumbnails.onCaptured} />,
          document.body,
        )}
    </div>
  );
}
