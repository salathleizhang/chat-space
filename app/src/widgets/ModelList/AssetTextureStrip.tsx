import { Suspense, useMemo } from "react";
import type { Object3D } from "three";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { collectTextureEntries } from "../../shared/lib/modelTextures";
import { LoadedAssetObject } from "../Viewport/ModelMesh";

/**
 * 悬浮卡里的贴图预览条：把资产模型用到的各通道贴图（base color / normal /
 * metallic-roughness …）横排成一行缩略图。
 *
 * 贴图内嵌在 glb 里、磁盘上没有独立 PNG，所以走前端抽取——`LoadedAssetObject` 与
 * 3D 视口共用同一份 loader 缓存，视口已渲染过的资产在这里是零网络请求。
 */

function TextureStrip({ object }: { object: Object3D }) {
  const entries = useMemo(() => collectTextureEntries(object), [object]);

  if (entries.length === 0) {
    return <span className="text-xs text-ink-faint">该模型没有贴图</span>;
  }

  return (
    /*
      不限张数：排不下就横向滚（气泡宽度上限 max-w-2xl 约能露出 6 张）。
      能滚的前提是 Tooltip 开了 interactive 档——默认气泡 pointer-events-none 收不到滚轮，
      当初正是因此才只能截断成 +n。pb-2 给悬浮式滚动条留位，免得压住材质名那行。
    */
    <div className="flex items-start gap-2 overflow-x-auto pb-2">
      {entries.map((entry) => (
        <div key={entry.id} className="flex w-24 shrink-0 flex-col gap-1">
          {entry.dataUrl ? (
            <img
              src={entry.dataUrl}
              alt={entry.label}
              className="h-24 w-24 rounded-media bg-field object-cover ring-1 ring-hairline"
            />
          ) : (
            <div className="flex h-24 w-24 items-center justify-center rounded-media bg-field px-2 text-center text-xs text-ink-faint ring-1 ring-hairline">
              压缩格式
            </div>
          )}
          <span className="truncate text-xs text-ink">{entry.label}</span>
          <span className="text-xs text-ink-faint">
            {entry.width}×{entry.height}
          </span>
          {/* 材质名：多个材质各有一张 Base Color 时靠这行区分，直接排出来不藏进 title */}
          {entry.materials.length > 0 && (
            <span className="truncate text-xs text-ink-faint">{entry.materials.join(", ")}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function AssetTextureStrip({ asset }: { asset: LibraryAsset }) {
  /*
    只对"视口确实会渲染的资产"抽贴图——那是共用 loader 缓存这个前提成立的范围。
    world 资产在视口里走的是高斯泼溅 spz（见 Viewport 的 SceneContents），它的
    modelPath 从来没被加载过，在这里抽贴图等于凭空拉一个几十 MB 的模型下来。
  */
  if (!asset.modelPath || asset.kind === "world") return null;
  return (
    <Suspense fallback={<span className="text-xs text-ink-faint">贴图加载中…</span>}>
      <LoadedAssetObject
        asset={asset}
        fallback={<span className="text-xs text-ink-faint">贴图加载失败</span>}
      >
        {(object) => <TextureStrip object={object} />}
      </LoadedAssetObject>
    </Suspense>
  );
}
