import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AgentDock } from "../../widgets/AgentDock";
import type { LiveTransforms } from "../../widgets/Viewport/liveTransforms";
import type { AssetMaterial, AssetTransform, LibraryAsset, Vec3 } from "../../shared/lib/libraryApi";
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
import { Inspector } from "../../widgets/Inspector";
import { ModelList } from "../../widgets/ModelList";
import { ThumbnailRenderer } from "../../widgets/ModelList/ThumbnailRenderer";
import { useThumbnailQueue } from "../../widgets/ModelList/useThumbnailQueue";
import { Sidebar, type SectionId } from "../../widgets/Sidebar";
import { Viewport } from "../../widgets/Viewport";
import { createLiveTransforms } from "../../widgets/Viewport/liveTransforms";
import { computeSceneLayout } from "../../widgets/Viewport/scenePlacement";
import type { TransformMode } from "../../widgets/Viewport/transformMode";
import { useAgentChat } from "./useAgentChat";
import { useAssetMaterials } from "./useAssetMaterials";
import { useChatMessages } from "./useChatMessages";
import { useProjectState } from "./useProjectState";
import { useReferenceImageSurfacing } from "./useReferenceImageSurfacing";
import { useSceneHistory } from "./useSceneHistory";
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
  /**
   * 拖拽期间的实时摆放表。住在这里而不是 Viewport 里，因为**右侧栏要订阅它**才能让数字
   * 跟着手走——它是两侧唯一的共同祖先。用 lazy ref 保证整个工作台只有一份实例。
   */
  const liveRef = useRef<LiveTransforms | null>(null);
  if (!liveRef.current) liveRef.current = createLiveTransforms();
  const live = liveRef.current;
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
    loaded: projectLoaded,
    projectName,
    projectError,
    plan,
    assets,
    referenceImages,
    currentSkybox,
    currentWorld,
    sceneTransforms,
    sceneMaterials,
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
    activeSessionStartedAt,
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

  /*
    参考图落盘就贴进对话：SSE 那条通道只在工具正常返回时有效，用户中途点停止、
    或参考图由 SceneJob 后台节点生成时都不会有任何事件到达界面。这里用项目状态里
    的参考图清单补这条缺口（判据与基线见该 hook 的头注）。
  */
  useReferenceImageSurfacing({
    ready: sessionReady,
    loaded: projectLoaded,
    referenceImages,
    sessionStartedAt: activeSessionStartedAt,
    messages,
    updateMessage,
  });

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
  /** 右侧栏改过的材质覆盖：同一份 scene.json 的另一张表，离散编辑所以不做防抖 */
  const handleMaterialSaveError = useCallback(
    (message: string) => reportError(`Failed to save material: ${message}`),
    [reportError],
  );
  const { materials, setMaterial, dropMaterial } = useAssetMaterials(
    projectSlug,
    sceneMaterials,
    handleMaterialSaveError,
  );

  /**
   * 生效摆放表：视口、右侧栏与撤销栈共用同一份。未摆过的资产取网格默认位（纯派生），
   * 所以它才是"用户眼下看到的"位置——撤销要还原的正是这个。
   */
  const layout = useMemo(() => computeSceneLayout(assets, transforms), [assets, transforms]);
  /**
   * 场景两表的键是资产**稳定 id**（`assetStableId`），撤销栈与右侧栏都按它反查。
   * 用 id 而不是 slug 建索引，正是为了让"删除后同名重建"拿到的是另一个键。
   */
  const assetsById = useMemo(() => {
    const map = new Map<string, LibraryAsset>();
    for (const asset of assets) map.set(asset.id, asset);
    return map;
  }, [assets]);

  /** 撤销栈要按资产 id 反查"改之前的摆放"，这一步走上面那张生效表 */
  const resolvePlacement = useCallback(
    (assetId: string) => {
      const asset = assetsById.get(assetId);
      return asset ? layout.get(asset.id) : undefined;
    },
    [assetsById, layout],
  );
  const isKnownAsset = useCallback((assetId: string) => assetsById.has(assetId), [assetsById]);
  const assetLabel = useCallback(
    (assetId: string) => assetsById.get(assetId)?.name ?? assetId,
    [assetsById],
  );

  /**
   * 撤销/重做：只覆盖用户在视口里的操作（拖拽、数值输入、换贴图），Agent 的增删不进栈。
   * 它发出的仍是普通的 `commitTransforms` / `setMaterial`，所以落盘顺序依旧由那两条队列保证。
   */
  const history = useSceneHistory({
    resolvePlacement,
    materials,
    isKnownAsset,
    assetLabel,
    commitTransforms,
    setMaterial,
    live,
  });

  /**
   * 右侧栏只服务"一个模型的详情"：多选时语义变成"整组"，与用户要的"选中单个模型时出现"
   * 不符，所以多选直接不出栏。判定与 Viewport 的 placedAssets 同源——world 走高斯泼溅背景、
   * 天空盒没有模型产物，两者都没有 position/rotate/scale 可谈。
   */
  const inspectorAsset = useMemo(() => {
    if (selectedAssets.length !== 1) return null;
    const [asset] = selectedAssets;
    if (!asset || asset.kind === "world" || !asset.modelPath) return null;
    return asset;
  }, [selectedAssets]);
  /**
   * 栏里显示的必须是**生效摆放**，不是 scene.json 里那一条——没被 gizmo 调过的资产在
   * scene.json 里根本没有记录，它的位置是 `computeSceneLayout` 按创建顺序派生的网格位。
   * 直接读 `transforms[id]` 会让未摆过的资产显示成全 0/单位值，而视口里它明明在网格上。
   */
  const inspectorTransform = useMemo(
    () => (inspectorAsset ? layout.get(inspectorAsset.id) : undefined),
    [layout, inspectorAsset],
  );
  const handleInspectorTransform = useCallback(
    (next: { position: Vec3; rotation: Vec3; scale: Vec3 }) => {
      if (!inspectorAsset) return;
      // 输入格每敲一个能解析成数字的字符就会提交一次，由历史栈在 500ms 内合并成一步。
      // 键是稳定 id（scene.json 的键），与 gizmo 提交的那条链路保持一致。
      history.commitPlacements({ [inspectorAsset.id]: next }, "field");
    },
    [history, inspectorAsset],
  );
  const handleTransformCommit = useCallback(
    (updates: Record<string, AssetTransform>, mode: TransformMode) => {
      history.commitPlacements(updates, "drag", mode);
    },
    [history],
  );
  const handleInspectorMaterial = useCallback(
    (next: AssetMaterial) => {
      if (!inspectorAsset) return;
      history.commitMaterial(inspectorAsset.assetSlug, next);
    },
    [history, inspectorAsset],
  );
  /**
   * 换贴图能挑的工程图片：生成的参考图 + 这个资产自己的源图（去重，源图常与参考图重合）。
   * 参考图条目带生成时间（给 useReferenceImageSurfacing 判归属用），这里只要路径。
   */
  const inspectorImages = useMemo(() => {
    if (!inspectorAsset) return [];
    return [
      ...new Set([
        ...referenceImages.map((reference) => reference.path),
        ...inspectorAsset.sourceImages,
      ]),
    ];
  }, [inspectorAsset, referenceImages]);

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
    sceneInspection,
    handleInspectionCaptured,
    handleSceneInspectionCaptured,
    send,
    answerQuestion,
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
      sessionStartedAt: activeSessionStartedAt,
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
      // 本地覆盖按稳定 id 摘；服务端那份由 deleteAsset 自己清
      dropTransform(asset.id);
      dropMaterial(asset.id);
      bumpRefresh();
    },
    [projectSlug, bumpRefresh, closePreviewFor, dropTransform, dropMaterial, flushPendingSave],
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
        materials={materials}
        live={live}
        onTransformCommit={handleTransformCommit}
        history={history}
        onSelectAsset={selectAsset}
        onClearSelection={clearSelection}
        onFocusAsset={focusAsset}
        onImportModel={handleImportModel}
        inspection={sceneInspection}
        onInspectionCaptured={handleSceneInspectionCaptured}
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
      {/*
        左上列表与左下工具栏共用这一栏：面板从 top-4 一直**可以**长到工具栏上方，
        高度由这段实际可用空间决定，不写死成 70vh —— 写死会在多资产项目里把后半截
        资产行裁在面板下方，而 macOS 覆盖式滚动条不滚动时没有任何提示，看起来就是
        "场景里有 10 件、列表里只显示 7 件"（实测 12 行需要 802px，70vh 只给 446px）。
        `bottom-24`（96px）= 工具栏高 42px + 底边距 16px + 间距 38px；`items-start` 让面板
        **内容自适应**：资产少时只占内容高，多时才长到这个上限、其余交给列表内部滚动。
        改工具栏尺寸/位置时记得同步这一项。
      */}
      <div className="absolute top-4 bottom-24 left-4 z-10 flex animate-chrome-enter items-start">
        {section === "images" ? (
          <ImageGallery images={referenceImages.map((reference) => reference.path)} />
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
      {inspectorAsset && inspectorTransform && (
        <div className="absolute top-4 right-4 z-10 animate-chrome-enter">
          <Inspector
            asset={inspectorAsset}
            transform={inspectorTransform}
            onTransformChange={handleInspectorTransform}
            live={live}
            material={materials[inspectorAsset.id]}
            onMaterialChange={handleInspectorMaterial}
            images={inspectorImages}
          />
        </div>
      )}
      {preview && (
        /*
          预览小窗与右侧栏抢同一个角落。选中态下右侧栏常驻（w-64 + 16px 边距 = 17rem），
          所以预览窗在栏位出现时整体左移，两个 chrome 面板永远不叠在一起。
        */
        <div
          className={`absolute top-4 z-20 animate-chrome-enter ${inspectorAsset ? "right-[18rem]" : "right-4"}`}
        >
          <Suspense fallback={null}>
            <ModelPreviewWindow
              asset={preview.asset}
              transform={transforms[preview.asset.id]}
              material={materials[preview.asset.id]}
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
        onAnswerQuestion={answerQuestion}
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
