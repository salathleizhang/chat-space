import { XIcon } from "@phosphor-icons/react/X";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { libraryUrl } from "../../shared/lib/libraryApi";
import { Button, Panel, Tooltip } from "../../shared/ui";

interface UploadedMessageImagesProps {
  paths: string[];
}

/** 用户消息里的上传图片；保持适合阅读原图的大图展示和独立预览交互。 */
export function UploadedMessageImages({ paths }: UploadedMessageImagesProps) {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const selectedName = selected?.split("/").pop() ?? selected;

  return (
    <>
      <div
        data-message-images="uploaded"
        className="mt-2 max-w-full overflow-x-auto"
      >
        <div className="flex w-max max-w-full gap-2">
          {paths.map((path) => {
            const fileName = path.split("/").pop() ?? path;
            return (
              <button
                key={path}
                type="button"
                aria-label={`预览上传图片 ${fileName}`}
                aria-haspopup="dialog"
                onClick={() => setSelected(path)}
                className="block max-w-full shrink-0 overflow-hidden rounded-media text-left transition-transform duration-150 ease-spring motion-safe:active:scale-[0.98]"
              >
                <img
                  src={libraryUrl(path)}
                  alt={fileName}
                  loading="lazy"
                  draggable="false"
                  className="block max-h-48 max-w-[min(28rem,75vw)] rounded-media object-contain"
                />
              </button>
            );
          })}
        </div>
      </div>

      {selected &&
        createPortal(
          <div
            data-uploaded-image-preview
            className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6"
            role="dialog"
            aria-modal="true"
            aria-label={`预览上传图片 ${selectedName}`}
            onClick={(event) => {
              if (event.target === event.currentTarget) setSelected(null);
            }}
          >
            <Panel className="flex max-h-[90vh] max-w-[90vw] animate-chrome-enter flex-col overflow-hidden p-2 motion-reduce:animate-none">
              <div className="flex items-center justify-between gap-4 px-3 py-2">
                <span className="min-w-0 truncate text-sm font-medium text-ink-strong">
                  {selectedName}
                </span>
                <Tooltip content="关闭" side="bottom">
                  <Button
                    variant="ghost"
                    shape="square"
                    size="sm"
                    icon={XIcon}
                    aria-label="关闭上传图片预览"
                    onClick={() => setSelected(null)}
                  />
                </Tooltip>
              </div>
              <img
                src={libraryUrl(selected)}
                alt={selectedName ?? "上传图片"}
                className="min-h-0 max-h-[76vh] max-w-[86vw] rounded-inset bg-field object-contain"
              />
            </Panel>
          </div>,
          document.body,
        )}
    </>
  );
}
