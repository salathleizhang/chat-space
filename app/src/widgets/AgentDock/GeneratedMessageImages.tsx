import { XIcon } from "@phosphor-icons/react/X";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { libraryUrl } from "../../shared/lib/libraryApi";
import { Button, Panel, Tooltip } from "../../shared/ui";

interface GeneratedMessageImagesProps {
  paths: string[];
}

/**
 * Agent 工具生成图的独立展示组件。
 * 后续生成状态、模型信息、重试/下载/选为参考图等能力都只在这里演进，
 * 不与用户上传图片的展示结构绑定。
 */
export function GeneratedMessageImages({ paths }: GeneratedMessageImagesProps) {
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
        data-message-images="generated"
        data-agent-generated-images
        className="mt-2 ml-[30px] max-w-[calc(100%-30px)] overflow-x-auto"
      >
        <div className="flex w-max max-w-full gap-2">
          {paths.map((path) => {
            const fileName = path.split("/").pop() ?? path;
            return (
              <button
                key={path}
                type="button"
                aria-label={`预览生成图片 ${fileName}`}
                aria-haspopup="dialog"
                onClick={() => setSelected(path)}
                className="block max-w-full shrink-0 overflow-hidden rounded-media transition-transform duration-150 ease-spring motion-safe:active:scale-[0.96]"
              >
                <img
                  src={libraryUrl(path)}
                  alt={fileName}
                  loading="lazy"
                  draggable="false"
                  className="h-16 w-16 rounded-media object-cover ring-2 ring-ink-strong"
                />
              </button>
            );
          })}
        </div>
      </div>

      {selected &&
        createPortal(
          <div
            data-generated-image-preview
            className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6"
            role="dialog"
            aria-modal="true"
            aria-label={`预览生成图片 ${selectedName}`}
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
                    aria-label="关闭生成图片预览"
                    onClick={() => setSelected(null)}
                  />
                </Tooltip>
              </div>
              <img
                src={libraryUrl(selected)}
                alt={selectedName ?? "生成图片"}
                className="min-h-0 max-h-[76vh] max-w-[86vw] rounded-inset bg-field object-contain"
              />
            </Panel>
          </div>,
          document.body,
        )}
    </>
  );
}
