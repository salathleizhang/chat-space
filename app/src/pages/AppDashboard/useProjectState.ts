import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  deriveLibraryAssets,
  fetchProjectState,
  type AssetMaterial,
  type AssetTransform,
  type LibraryAsset,
  type ProjectPlan,
} from "../../shared/lib/libraryApi";

/** 没有 scene.json 时共用同一个空表，免得每次重扫都造新引用触发下游重算 */
const NO_TRANSFORMS: Record<string, AssetTransform> = {};
const NO_MATERIALS: Record<string, AssetMaterial> = {};

/**
 * 当前项目名 + 派生计划状态 + 资产列表（ModelList 与 Viewport 共用的共享场景数据源）
 * + 磁盘上的场景摆放与材质覆盖（scene.json，本地改动的叠加见 `useSceneTransforms` /
 * `useAssetMaterials`）；项目不存在时重定向回项目列表。
 */
export function useProjectState(
  projectSlug: string,
  refreshKey: number,
) {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<{
    projectName: string;
    projectError: string | null;
    plan: ProjectPlan | null;
    assets: LibraryAsset[];
    referenceImages: string[];
    currentSkybox?: string;
    currentWorld?: string;
    sceneTransforms: Record<string, AssetTransform>;
    sceneMaterials: Record<string, AssetMaterial>;
  }>(() => ({
    projectName: "",
    projectError: null,
    plan: null,
    assets: [],
    referenceImages: [],
    sceneTransforms: NO_TRANSFORMS,
    sceneMaterials: NO_MATERIALS,
  }));

  useEffect(() => {
    if (!projectSlug) {
      navigate("/app", { replace: true });
      return;
    }
    // 陈旧响应守卫：快速从项目 A 切到 B 时，若 A 的响应后到，不加这道闸门
    // 会把 A 的资产/计划/摆放整套写进 B 的工作台
    let cancelled = false;
    void fetchProjectState(projectSlug)
      .then((state) => {
        if (cancelled) return;
        if (!state) {
          navigate("/app", { replace: true });
          return;
        }
        setSnapshot({
          projectName: state.project.name,
          projectError: null,
          plan: state.plan ?? null,
          assets: deriveLibraryAssets(projectSlug, state, refreshKey),
          referenceImages: state.generatedReferences ?? [],
          currentSkybox: state.project.currentSkybox,
          currentWorld: state.project.currentWorld,
          sceneTransforms: state.scene?.transforms ?? NO_TRANSFORMS,
          sceneMaterials: state.scene?.materials ?? NO_MATERIALS,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 同一项目刷新失败时保留最后一份完整快照，不能只清资产却留下旧计划/环境，
        // 那会制造一份从未在磁盘上存在过的混合状态。首次加载则本来就是全空初值。
        setSnapshot((current) => ({
          ...current,
          projectName: current.projectName || projectSlug,
          projectError: err instanceof Error ? err.message : String(err),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, projectSlug, refreshKey]);

  return snapshot;
}
