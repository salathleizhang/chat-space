import { useLayoutEffect } from "react";
import type { Object3D } from "three";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { MATERIAL_TEXTURE_SLOTS } from "../../shared/lib/libraryApi";
import { publishModelDescription, clearModelDescription } from "../../shared/lib/modelDescription";
import { collectSupportedSlots } from "../../shared/lib/materialOverrides";
import { collectChannelTextures } from "../../shared/lib/modelTextures";

/**
 * 渲染层的**模型描述生产方**（three 版）。
 *
 * 挂在真实渲染路径上（`ModelMesh` 里模型加载完成处），而不是挂在 Inspector 自己那份加载器上——
 * 后者是待消除的越界访问：编辑层不该为了回答"这个模型支持哪些通道"而自己挂载一份模型。
 *
 * 发布的是**原始事实**（模型材质真正声明了哪些通道、每个通道现在挂的是哪张图），
 * 显示策略（哪些通道要列出来）留给消费方，因为它才看得见用户的覆盖记录。
 *
 * 键用 `asset.id`（**稳定 id**）而不是 `assetSlug`：后者是目录名，删掉同名资产重建会复用，
 * 描述就会串到新资产上。scene.json 的 transforms / materials 两张表同样按稳定 id 索引。
 *
 * 本文件随 three 一起删除；PlayCanvas 版由模型加载路径发布同一份契约。
 */
export function ModelDescriptionPublisher({ asset, object }: { asset: LibraryAsset; object: Object3D }) {
  useLayoutEffect(() => {
    publishModelDescription(asset.id, {
      status: "ready",
      supportedSlots: [...collectSupportedSlots(object, MATERIAL_TEXTURE_SLOTS)],
      channels: collectChannelTextures(object, MATERIAL_TEXTURE_SLOTS),
    });
    // 模型卸载或换代时移除描述，否则 Inspector 会显示一个已经不存在的模型的通道。
    return () => clearModelDescription(asset.id);
  }, [asset.id, object]);
  return null;
}
