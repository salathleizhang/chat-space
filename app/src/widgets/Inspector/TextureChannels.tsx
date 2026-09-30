import { ArrowUUpLeftIcon } from "@phosphor-icons/react/ArrowUUpLeft";
import { ImageSquareIcon } from "@phosphor-icons/react/ImageSquare";
import { SwapIcon } from "@phosphor-icons/react/Swap";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { libraryUrl, type LibraryAsset, type MaterialTextureSlot } from "../../shared/lib/libraryApi";
import { SLOT_LABELS } from "../../shared/lib/materialSchema";
import { useModelDescription } from "../../shared/lib/modelDescription";
import { Button, Tooltip } from "../../shared/ui";
import { placePopover, type PopoverPlacement } from "../../shared/ui/popoverPosition";

/**
 * 材质区的贴图通道表：每个通道一行，显示"现在这一格是谁"，并提供换成工程里另一张图、
 * 或换回模型自带贴图。
 *
 * 通道的**当前值有两个来源**，取值优先级与视口完全一致（见 materialOverride.ts）：
 *   ① scene.json 里的覆盖 → 直接显示那张工程图的缩略图；
 *   ② 否则是模型自带贴图 → 由 `LoadedAssetObject` 复用视口那份 loader 缓存抽出来，
 *      命中缓存时零网络请求（与 ModelList 悬浮卡的贴图条同源）。
 */

/** 换贴图的候选来源：工程里所有能当贴图用的图片逻辑路径 */
function ImagePicker({
  placement,
  images,
  onPick,
  onClose,
}: {
  placement: PopoverPlacement;
  images: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        style={{
          left: placement.left,
          top: placement.top,
          bottom: placement.bottom,
          width: placement.minWidth,
          maxHeight: placement.maxHeight,
        }}
        className={`fixed z-50 flex flex-col gap-2 overflow-y-auto rounded-surface border border-line bg-surface-raised p-2 shadow-lg backdrop-blur-md transition-[opacity,scale] duration-150 ease-spring starting:scale-95 starting:opacity-0 motion-reduce:starting:scale-100 ${
          placement.openUp ? "origin-bottom-left" : "origin-top-left"
        }`}
      >
        <span className="px-2 pt-1 text-xs text-ink-subtle">
          {images.length} project {images.length === 1 ? "image" : "images"}
        </span>
        <div className="grid grid-cols-3 gap-1">
          {images.map((path) => {
            const fileName = path.split("/").pop() ?? path;
            return (
              <button
                key={path}
                type="button"
                title={fileName}
                aria-label={`Use ${fileName}`}
                onClick={() => onPick(path)}
                className="group flex min-w-0 flex-col gap-1 rounded-inset p-1 transition-colors hover:bg-fill"
              >
                <img
                  src={libraryUrl(path)}
                  alt=""
                  loading="lazy"
                  draggable="false"
                  className="aspect-square w-full rounded-media bg-field object-cover ring-1 ring-hairline"
                />
                <span className="truncate text-[10px] text-ink-subtle">{fileName}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}

interface ChannelRowProps {
  slot: MaterialTextureSlot;
  /** scene.json 里这一格的覆盖路径；null 即用模型自带贴图 */
  override: string | null;
  /** 模型自带贴图（没有则是 undefined） */
  model: { dataUrl: string | null; width: number; height: number } | undefined;
  images: string[];
  onChange: (slot: MaterialTextureSlot, path: string | null) => void;
}

function ChannelRow({ slot, override, model, images, onChange }: ChannelRowProps) {
  const [picker, setPicker] = useState<PopoverPlacement | null>(null);
  const buttonRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!picker) return;
    const close = () => setPicker(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [picker]);

  const thumbnail = override ? (
    <img
      src={libraryUrl(override)}
      alt=""
      draggable="false"
      className="h-10 w-10 shrink-0 rounded-media bg-field object-cover ring-1 ring-hairline"
    />
  ) : model?.dataUrl ? (
    <img
      src={model.dataUrl}
      alt=""
      draggable="false"
      className="h-10 w-10 shrink-0 rounded-media bg-field object-cover ring-1 ring-hairline"
    />
  ) : (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-media bg-field text-ink-faint ring-1 ring-hairline">
      <ImageSquareIcon size={18} weight="regular" />
    </div>
  );

  const source = override
    ? (override.split("/").pop() ?? override)
    : model
      ? model.dataUrl
        ? `Model · ${model.width}×${model.height}`
        : "Model · compressed"
      : "Not set";

  const canPick = images.length > 0;

  return (
    <div className="flex items-center gap-2 rounded-inset px-2 py-1.5 hover:bg-fill">
      {thumbnail}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-ink">{SLOT_LABELS[slot]}</span>
        <span className="truncate text-[10px] text-ink-faint">{source}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Tooltip
          content={
            canPick
              ? "Replace with a project image"
              : "No project images yet — ask the agent to generate or edit one"
          }
        >
          {/* 锚点包一层：Button 是纯函数组件（不接受 ref），定位要读 DOM 尺寸只能量外壳 */}
          <span ref={buttonRef} className="inline-flex">
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={SwapIcon}
              aria-label={`Replace ${SLOT_LABELS[slot]} texture`}
              disabled={!canPick}
              onClick={() => {
                const rect = buttonRef.current?.getBoundingClientRect();
                if (!rect) return;
                // 3 列缩略图（每列约 72px）+ 内边距；理想高度约 3 行 + 标题行
                setPicker(placePopover(rect, { preferredHeight: 288, minWidth: 232 }));
              }}
            />
          </span>
        </Tooltip>
        {override && (
          <Tooltip content="Back to the model's own texture">
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={ArrowUUpLeftIcon}
              aria-label={`Reset ${SLOT_LABELS[slot]} texture`}
              onClick={() => onChange(slot, null)}
            />
          </Tooltip>
        )}
      </span>
      {picker && (
        <ImagePicker
          placement={picker}
          images={images}
          onPick={(path) => {
            onChange(slot, path);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function ChannelList({
  assetId,
  slots,
  textures,
  images,
  onChange,
}: {
  assetId: string;
  slots: readonly MaterialTextureSlot[];
  textures: Partial<Record<MaterialTextureSlot, string>>;
  images: string[];
  onChange: (slot: MaterialTextureSlot, path: string | null) => void;
}) {
  /*
    数据来自**渲染层发布的"模型描述"**（见 shared/lib/modelDescription.ts），
    不再由本面板自己挂载一份模型加载器去遍历 three 对象。
  */
  const description = useModelDescription(assetId);

  /**
   * 候选表是七个通道的并集，但原材质不一定认全部（phong 没有 roughnessMap、
   * basic 没有 normalMap），换上去不会有任何效果。这里按模型真实声明的属性收窄；
   * 已经被覆盖过的通道一律保留，否则用户（或 agent）写下的旧覆盖会连"换回原图"都点不到。
   */
  const visible = useMemo(() => {
    const supported = new Set(description?.supportedSlots ?? []);
    return slots.filter((slot) => supported.has(slot) || textures[slot] != null);
  }, [description, slots, textures]);

  const model = description?.channels ?? new Map();
  const missing = description === undefined;

  if (missing) {
    return <p className="px-3 py-2 text-xs text-ink-faint">Loading model textures…</p>;
  }
  if (visible.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-ink-subtle">
        This model's materials do not declare any replaceable texture channel.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {visible.map((slot) => (
        <ChannelRow
          key={slot}
          slot={slot}
          override={textures[slot] ?? null}
          model={model.get(slot)}
          images={images}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

export function TextureChannels({
  asset,
  slots,
  textures,
  images,
  onChange,
}: {
  asset: LibraryAsset;
  slots: readonly MaterialTextureSlot[];
  textures: Partial<Record<MaterialTextureSlot, string>>;
  images: string[];
  onChange: (slot: MaterialTextureSlot, path: string | null) => void;
}) {
  if (!asset.modelPath) return null;
  // 不再自己挂载模型加载器：模型由视口加载并发布描述，这里只消费。
  return (
    <ChannelList
      assetId={asset.id}
      slots={slots}
      textures={textures}
      images={images}
      onChange={onChange}
    />
  );
}
