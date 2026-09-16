import type { Icon } from "@phosphor-icons/react";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { GlobeHemisphereWestIcon } from "@phosphor-icons/react/GlobeHemisphereWest";
import { ImageSquareIcon } from "@phosphor-icons/react/ImageSquare";
import { MountainsIcon } from "@phosphor-icons/react/Mountains";
import type { LibraryAsset } from "../../shared/lib/libraryApi";

/**
 * 资产行左侧的方形预览图。有缩略图就直出（透明底 PNG，直接坐在面板玻璃上），
 * 没有则按 kind 显示占位图标——模型渲模型、天空盒渲贴了环境贴图的球，
 * 二者之外（world/image/texture）仍永远走占位这条。
 */

const KIND_ICONS: Record<string, Icon> = {
  skybox: GlobeHemisphereWestIcon,
  world: MountainsIcon,
  image: ImageSquareIcon,
  texture: ImageSquareIcon,
};

export function AssetThumbnail({
  asset,
  src,
  pending,
}: {
  asset: LibraryAsset;
  src: string | null;
  /** 排在渲染队列里：占位图轻微呼吸，提示这张图正在路上 */
  pending?: boolean;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="h-10 w-10 shrink-0 rounded-media bg-field object-contain ring-1 ring-hairline"
      />
    );
  }

  const PlaceholderIcon = KIND_ICONS[asset.kind] ?? CubeIcon;
  return (
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-media bg-field text-ink-faint ring-1 ring-hairline ${
        pending ? "animate-pulse" : ""
      }`}
    >
      <PlaceholderIcon size={18} weight="regular" />
    </div>
  );
}
