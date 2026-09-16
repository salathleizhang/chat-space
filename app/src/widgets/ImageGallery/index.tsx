import { ImageSquareIcon } from "@phosphor-icons/react/ImageSquare";
import { XIcon } from "@phosphor-icons/react/X";
import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { libraryUrl } from "../../shared/lib/libraryApi";
import { Button, Panel, Tooltip } from "../../shared/ui";

interface ImageGalleryProps {
  images: string[];
}

/** 左下“图片”入口只展示为 3D 生成而生成/编辑的参考图；点击可放大查看。 */
export const ImageGallery = memo(function ImageGallery({ images }: ImageGalleryProps) {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  return (
    <>
      <Panel className="flex max-h-[70vh] w-80 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-sm font-medium text-ink-strong">参考图</span>
          <span className="text-[11px] text-ink-subtle">{images.length}</span>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto p-2">
          {images.length === 0 && (
            <div className="col-span-2 flex min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-ink-subtle">
              <ImageSquareIcon size={24} weight="regular" className="text-ink-faint" />
              <span>还没有生成过参考图。</span>
            </div>
          )}
          {images.map((path) => {
            const fileName = path.split("/").pop() ?? path;
            return (
              <button
                key={path}
                type="button"
                aria-label={`查看参考图 ${fileName}`}
                onClick={() => setSelected(path)}
                className="group relative aspect-square min-w-0 overflow-hidden rounded-media bg-field text-left ring-1 ring-hairline transition-[transform,background-color] duration-150 ease-spring hover:bg-fill motion-safe:active:scale-[0.98]"
              >
                <img
                  src={libraryUrl(path)}
                  alt={fileName}
                  loading="lazy"
                  draggable="false"
                  className="h-full w-full object-cover transition-transform duration-200 ease-spring group-hover:scale-[1.03]"
                />
                <span className="absolute inset-x-1.5 bottom-1.5 truncate rounded-full bg-canvas/65 px-2 py-1 text-[10px] text-ink backdrop-blur-sm">
                  参考图
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      {selected &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6"
            role="dialog"
            aria-modal="true"
            aria-label={`预览 ${selected.split("/").pop() ?? selected}`}
            onClick={(event) => {
              if (event.target === event.currentTarget) setSelected(null);
            }}
          >
            <Panel className="flex max-h-[90vh] max-w-[90vw] flex-col overflow-hidden p-2">
              <div className="flex items-center justify-between gap-4 px-3 py-2">
                <span className="min-w-0 truncate text-sm text-ink-strong">
                  {selected.split("/").pop() ?? selected}
                </span>
                <Tooltip content="关闭" side="bottom">
                  <Button
                    variant="ghost"
                    shape="square"
                    size="sm"
                    icon={XIcon}
                    aria-label="关闭图片预览"
                    onClick={() => setSelected(null)}
                  />
                </Tooltip>
              </div>
              <img
                src={libraryUrl(selected)}
                alt={selected.split("/").pop() ?? selected}
                className="min-h-0 max-h-[76vh] max-w-[86vw] rounded-inset bg-field object-contain"
              />
              <div className="flex items-center justify-between gap-4 px-3 py-2 text-xs text-ink-subtle">
                <span>参考图</span>
                <span className="max-w-[60vw] truncate">
                  {selected.split("/").pop() ?? selected}
                </span>
              </div>
            </Panel>
          </div>,
          document.body,
        )}
    </>
  );
});
