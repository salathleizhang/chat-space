import { useCallback, useMemo, useRef, useState } from "react";
import { saveSceneMaterials, type AssetMaterial } from "../../shared/lib/libraryApi";

/**
 * 右侧栏改过的材质覆盖：磁盘上 scene.json 的 materials 表叠加本会话改动。
 *
 * 与 `useSceneTransforms` 同一套两条纪律（乐观更新 + 本地覆盖优先于服务端），但**不做防抖**：
 * 摆放是每帧都在变的拖拽，材质是"换一张图"的离散动作，攒 500ms 只会让用户觉得点了没反应。
 * 取而代之的是严格按产生顺序执行的保存队列——连点两次"换贴图"，两次 PUT 必须按顺序到达，
 * 否则服务端按键浅合并时后到的旧值会把新值顶掉。
 */
export function useAssetMaterials(
  projectSlug: string,
  remote: Record<string, AssetMaterial>,
  onError?: (message: string) => void,
) {
  // ProjectDashboard 以 projectSlug 为 key，切项目会重挂载，本地账本天然隔离。
  const [local, setLocal] = useState<Record<string, AssetMaterial>>({});

  const materials = useMemo(() => ({ ...remote, ...local }), [remote, local]);

  const saveTailRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueSave = useCallback(
    (values: Record<string, AssetMaterial>) => {
      const request = saveTailRef.current
        .catch(() => undefined)
        .then(() => saveSceneMaterials(projectSlug, values));
      saveTailRef.current = request;
      void request.catch((err: unknown) => {
        onError?.(err instanceof Error ? err.message : String(err));
      });
    },
    [projectSlug, onError],
  );

  /**
   * 写入某个资产的材质。语义默认值（保持原材质、无覆盖）**也落盘**，不从文件里删条目：
   * 服务端的合并是按 slug 浅合并，删键需要另一条端点，而"写回默认值"与"没有记录"在读取侧
   * 完全等价（见 `isDefaultMaterial`），所以用值表达即可，保存路径只有一条。
   */
  const setMaterial = useCallback(
    (assetSlug: string, material: AssetMaterial) => {
      setLocal((prev) => ({ ...prev, [assetSlug]: material }));
      enqueueSave({ [assetSlug]: material });
    },
    [enqueueSave],
  );

  /** 资产删除后摘掉本地覆盖；服务端那份由 `deleteAsset` 自己清 */
  const dropMaterial = useCallback((assetSlug: string) => {
    setLocal((prev) => {
      if (!(assetSlug in prev)) return prev;
      const { [assetSlug]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);

  return { materials, setMaterial, dropMaterial };
}
