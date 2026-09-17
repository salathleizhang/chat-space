import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CubeFocusIcon } from "@phosphor-icons/react/CubeFocus";
import { FolderSimplePlusIcon } from "@phosphor-icons/react/FolderSimplePlus";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { SquaresFourIcon } from "@phosphor-icons/react/SquaresFour";
import { XIcon } from "@phosphor-icons/react/X";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ACCEPTED_IMAGE_TYPES, imageFileFromClipboard } from "../shared/lib/imageAttachment";
import { createProject } from "../shared/lib/libraryApi";
import { Button, Input, Panel, Tooltip } from "../shared/ui";

const MODEL_ACTIONS = ["Model", "Unwrap", "UV-map", "Texture", "Skin", "Rig"] as const;
const WORD_DURATION_MS = 2400;

export function HomePage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (!imageFile) {
      setImagePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let interval: number | undefined;
    const syncMotionPreference = () => {
      window.clearInterval(interval);
      if (reducedMotion.matches) {
        setActionIndex(0);
      } else {
        interval = window.setInterval(
          () => setActionIndex((index) => (index + 1) % MODEL_ACTIONS.length),
          WORD_DURATION_MS,
        );
      }
    };

    syncMotionPreference();
    reducedMotion.addEventListener("change", syncMotionPreference);
    return () => {
      window.clearInterval(interval);
      reducedMotion.removeEventListener("change", syncMotionPreference);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectName =
      name.trim() ||
      (imageFile
        ? imageFile.name.replace(/\.[^.]+$/, "").trim().slice(0, 120) || "Image project"
        : "");
    if (!projectName || creating) return;

    setCreating(true);
    setError(null);
    try {
      const project = await createProject(projectName);
      navigate(`/app/${project.slug}`, {
        state: imageFile ? { initialImageFile: imageFile } : null,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (creating || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    if (creating) return;
    const file = Array.from(event.dataTransfer.files).find((candidate) =>
      ACCEPTED_IMAGE_TYPES.includes(candidate.type),
    );
    if (file) setImageFile(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const file = imageFileFromClipboard(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    setImageFile(file);
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-project-hub-canvas text-project-hub-ink">
      <div className="pointer-events-none fixed inset-x-0 top-3 z-10 flex justify-center">
        <Panel
          variant="liquid"
          className="animate-chrome-enter-center pointer-events-auto flex w-[min(56rem,calc(100%-2rem))] items-center justify-between rounded-full! py-2 pr-2 pl-5"
        >
          <div className="flex items-center gap-2">
            <CubeFocusIcon size={24} weight="duotone" className="text-ink-strong" />
            <span className="text-sm font-medium text-ink-strong">ChatSpace</span>
          </div>
          <nav className="flex items-center gap-1" aria-label="Main navigation">
            <Button variant="ghost" onClick={() => navigate("/app")}>Projects</Button>
            <Button
              variant="primary"
              icon={FolderSimplePlusIcon}
              onClick={() => navigate("/app?create=1")}
            >
              Create project
            </Button>
          </nav>
        </Panel>
      </div>

      <main className="animate-chrome-enter mx-auto w-full max-w-5xl px-6 pt-32 pb-16">
        <section className="mx-auto flex max-w-3xl flex-col items-center text-center" aria-labelledby="home-title">
          <h1
            id="home-title"
            aria-label="Say it, Model it"
            className="text-3xl font-semibold tracking-tight text-project-hub-ink-strong sm:text-4xl"
          >
            Say it,{" "}
            <span className="whitespace-nowrap" aria-hidden="true">
              <span key={actionIndex} className="home-rotating-word inline-block">
                {MODEL_ACTIONS[actionIndex]}
              </span>{" "}
              it
            </span>
          </h1>
          <p className="mt-3 text-sm text-project-hub-ink-subtle">
            Name your project or add an image to start building in ChatSpace.
          </p>

          <Panel
            className="relative mt-9 w-full px-3 py-2"
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={() => {
              dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
              if (dragDepthRef.current === 0) setIsDragOver(false);
            }}
            onDrop={handleDrop}
          >
            {isDragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-fill-active text-sm text-ink">
                Drop to upload image
              </div>
            )}
            {imageFile && (
              <div className="flex items-center gap-3 px-2 pb-2 text-left">
                <div className="relative h-16 w-16 shrink-0">
                  {imagePreviewUrl && (
                    <img
                      src={imagePreviewUrl}
                      alt=""
                      className="h-16 w-16 rounded-media object-cover ring-2 ring-ink-strong"
                    />
                  )}
                  <Button
                    variant="primary"
                    shape="circle"
                    size="xs"
                    icon={XIcon}
                    aria-label="Remove image"
                    className="absolute -top-1.5 -right-1.5"
                    disabled={creating}
                    onClick={() => {
                      setImageFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                  />
                </div>
                <span className="min-w-0 text-xs text-project-hub-ink-subtle">
                  The image will be analyzed after the project is created.
                </span>
              </div>
            )}
            <form onSubmit={(event) => void submit(event)} className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(",")}
                className="hidden"
                disabled={creating}
                onChange={(event) => setImageFile(event.target.files?.[0] ?? null)}
              />
              <Tooltip content="Upload an image to start creating">
                <Button
                  variant="secondary"
                  shape="circle"
                  size="lg"
                  icon={PlusIcon}
                  aria-label="Upload image"
                  className="control-edge-lit shrink-0 border border-line hover:border-ink-faint"
                  disabled={creating}
                  onClick={() => fileInputRef.current?.click()}
                />
              </Tooltip>
              <Input
                id="home-project-name"
                variant="plain"
                size="lg"
                className="min-w-0 flex-1"
                aria-label="Project name"
                placeholder={imageFile ? "Project name (optional)" : "Name your new project…"}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onPaste={handlePaste}
                autoComplete="off"
                maxLength={120}
                disabled={creating}
              />
              <Button
                type="submit"
                variant="primary"
                shape="circle"
                size="lg"
                icon={ArrowRightIcon}
                className="shrink-0"
                disabled={(!name.trim() && !imageFile) || creating}
                aria-label={creating ? "Creating project" : imageFile ? "Create project and analyze image" : "Create project from name"}
              />
            </form>
          </Panel>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-signal">{error}</p>
          ) : (
            <p className="mt-3 text-xs text-project-hub-ink-faint">
              {imageFile ? "Press Enter to create your project and analyze the image" : "Press Enter to create your project"}
            </p>
          )}
        </section>

        <section className="mt-20" aria-labelledby="cases-title">
          <div className="mb-6 flex items-baseline justify-between">
            <h2 id="cases-title" className="text-sm font-medium text-project-hub-ink-strong">Cases</h2>
            <span className="text-xs text-project-hub-ink-subtle">0 total</span>
          </div>
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <SquaresFourIcon size={36} weight="thin" className="text-project-hub-ink-faint" />
            <span className="text-sm text-project-hub-ink-subtle">No cases yet</span>
            <span className="text-xs text-project-hub-ink-faint">
              Cases made with ChatSpace will appear here when they are added.
            </span>
          </div>
        </section>
      </main>
    </div>
  );
}
