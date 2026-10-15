import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CubeFocusIcon } from "@phosphor-icons/react/CubeFocus";
import { FolderSimplePlusIcon } from "@phosphor-icons/react/FolderSimplePlus";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { SquaresFourIcon } from "@phosphor-icons/react/SquaresFour";
import { XIcon } from "@phosphor-icons/react/X";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { preloadAppDashboard } from "../app/router";
import { ACCEPTED_IMAGE_TYPES, imageFilesFromClipboard } from "../shared/lib/imageAttachment";
import { createProject } from "../shared/lib/libraryApi";
import { Button, Input, Panel, Tooltip } from "../shared/ui";
import { FeatureShowcase, WorldShowcase } from "./HomeSections";
import type { ShowcaseWorld } from "./homeShowcase";
import { browserHomeLocale, HOME_ACTIONS, HOME_COPY, HOME_FEATURES, HOME_WORLDS, savedHomeLocale, saveHomeLocale, type HomeLocale } from "./homeCopy";
import "./home.css";

const WORD_DURATION_MS = 2400;

export function HomePage() {
  const navigate = useNavigate();
  const [browserLocale, setBrowserLocale] = useState(browserHomeLocale);
  const [languagePreference, setLanguagePreference] = useState(savedHomeLocale);
  const locale = languagePreference ?? browserLocale;
  const copy = HOME_COPY[locale];
  const actions = HOME_ACTIONS[locale];
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imagePreviewUrls, setImagePreviewUrls] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    const syncLanguage = () => setBrowserLocale(browserHomeLocale());
    window.addEventListener("languagechange", syncLanguage);
    return () => window.removeEventListener("languagechange", syncLanguage);
  }, []);

  useEffect(() => {
    const urls = imageFiles.map((file) => URL.createObjectURL(file));
    setImagePreviewUrls(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [imageFiles]);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let interval: number | undefined;
    const syncMotionPreference = () => {
      window.clearInterval(interval);
      if (reducedMotion.matches) {
        setActionIndex(0);
      } else {
        interval = window.setInterval(
          () => setActionIndex((index) => (index + 1) % actions.length),
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
  }, [actions.length]);

  function selectLanguage(next: HomeLocale) {
    setLanguagePreference(next);
    setActionIndex(0);
    saveHomeLocale(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectName =
      name.trim() ||
      (imageFiles.length > 0
        ? imageFiles[0]!.name.replace(/\.[^.]+$/, "").trim().slice(0, 120) || copy.imageProject
        : "");
    if (!projectName || creating) return;

    setCreating(true);
    setError(null);
    try {
      const project = await createProject(projectName);
      navigate(`/app/${project.slug}`, {
        state: imageFiles.length > 0 ? { initialImageFiles: imageFiles } : null,
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
    const files = Array.from(event.dataTransfer.files).filter((candidate) =>
      ACCEPTED_IMAGE_TYPES.includes(candidate.type),
    );
    if (files.length > 0) setImageFiles((current) => [...current, ...files]);
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    setImageFiles((current) => [...current, ...files]);
  }

  /**
   * 点世界缩略图：有 `projectSlug` 就进那个世界所在的项目工作台（进去后视口会把该世界
   * 作为当前世界渲染）；占位世界（还没接真实项目）回项目列表，不让用户点进一个空路由。
   */
  function openWorld(world: ShowcaseWorld) {
    navigate(world.projectSlug ? `/app/${world.projectSlug}` : "/app");
  }

  return (
    <div className="home-landing sky-surface h-full w-full overflow-y-auto" lang={locale}>
      <header className="home-header sky-header">
        <Panel variant="liquid" className="home-header-glass sky-header-glass sky-glass" aria-hidden="true" />
        <div className="home-brand sky-brand">
          <CubeFocusIcon size={26} weight="bold" />
          <span>ChatSpace</span>
        </div>
        <nav className="home-nav flex items-center gap-1" aria-label={copy.mainNavigation}>
          <div className="home-language-switch" role="group" aria-label={copy.languageSelection}>
            <Button
              variant="ghost"
              className="home-language-button"
              lang="zh-CN"
              aria-pressed={locale === "zh-CN"}
              onClick={() => selectLanguage("zh-CN")}
            >中文</Button>
            <Button
              variant="ghost"
              className="home-language-button"
              lang="en"
              aria-pressed={locale === "en"}
              onClick={() => selectLanguage("en")}
            >EN</Button>
          </div>
          <Button variant="ghost" className="home-nav-projects" onClick={() => navigate("/app")}>{copy.projects}</Button>
          <Button
            variant="primary"
            icon={FolderSimplePlusIcon}
            className="home-nav-create sky-create"
            onClick={() => navigate("/app?create=1")}
          >
            {copy.createProject}
          </Button>
        </nav>
      </header>

      <main className="home-main">
        <section className="home-hero" aria-labelledby="home-title">
          <h1 id="home-title" className="home-wordmark">ChatSpace</h1>
          <img
            className="home-mascot"
            src="/landing/mascot.png"
            alt={copy.mascotAlt}
            width={3367}
            height={1846}
            fetchPriority="high"
            draggable={false}
          />

          <Panel
            className="home-composer relative w-full"
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
                {copy.dropImage}
              </div>
            )}
            {imageFiles.length > 0 && (
              <div className="flex items-center gap-3 px-2 pb-2 text-left">
                <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto px-1 pt-4 pb-2">
                  {imageFiles.map((file, index) => (
                    <div key={index} className="relative h-16 w-16 shrink-0">
                      {imagePreviewUrls[index] && (
                        <img
                          src={imagePreviewUrls[index]}
                          alt={file.name}
                          className="h-16 w-16 rounded-[calc(var(--radius-surface)-1.5rem)] bg-field object-contain ring-2 ring-ink-strong"
                        />
                      )}
                      <Button
                        variant="primary"
                        shape="circle"
                        size="xs"
                        icon={XIcon}
                        aria-label={copy.removeImage(file.name)}
                        className="absolute top-0 right-0"
                        disabled={creating}
                        onClick={() => setImageFiles((current) => current.filter((_, i) => i !== index))}
                      />
                    </div>
                  ))}
                </div>
                <span className="min-w-0 text-xs text-ink-subtle">
                  {copy.imagesQueued(imageFiles.length)}
                </span>
              </div>
            )}
            <form onSubmit={(event) => void submit(event)} className="home-create-form flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(",")}
                multiple
                className="hidden"
                disabled={creating}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []).filter((file) => ACCEPTED_IMAGE_TYPES.includes(file.type));
                  if (files.length > 0) setImageFiles((current) => [...current, ...files]);
                  event.target.value = "";
                }}
              />
              <Tooltip content={copy.uploadHint}>
                <Button
                  variant="secondary"
                  shape="circle"
                  size="lg"
                  icon={PlusIcon}
                  aria-label={copy.uploadImage}
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
                aria-label={copy.projectName}
                placeholder={imageFiles.length > 0 ? copy.projectNameOptional : copy.projectPlaceholder}
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
                className="home-submit shrink-0"
                disabled={(!name.trim() && imageFiles.length === 0) || creating}
                aria-label={creating ? copy.creatingProject : imageFiles.length > 0 ? copy.createWithImages : copy.createFromName}
              />
            </form>
          </Panel>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-signal">{error}</p>
          ) : (
            <p className="home-enter-hint">
              {imageFiles.length > 0 ? copy.enterWithImages : copy.enterToCreate}
            </p>
          )}
          <p className="home-project-hint">
            {copy.projectHint}
          </p>

          <div className="home-manifesto">
            <div className="home-manifesto-copy">
              <h2 aria-label={copy.heroAccessible}>
                {copy.heroPrefix}<br />
                <span className="whitespace-nowrap" aria-hidden="true">
                  {locale === "zh-CN" ? "就会" : " "}
                  <span key={`${locale}-${actionIndex}`} className="home-rotating-word inline-block">{actions[actionIndex]}</span>{copy.heroSuffix}
                </span>
              </h2>
              {copy.heroTagline && <p className="home-tagline">{copy.heroTagline}</p>}
            </div>
          </div>
        </section>

        <WorldShowcase
          worlds={HOME_WORLDS[locale]}
          copy={copy}
          onOpenWorld={openWorld}
          onIntent={() => void preloadAppDashboard()}
        />

        <FeatureShowcase features={HOME_FEATURES[locale]} copy={copy} />

        <section className="home-cases" aria-labelledby="cases-title">
          <div className="home-section-heading">
            <h2 id="cases-title">{copy.casesTitle}</h2>
            <span>{copy.casesCount}</span>
          </div>
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <SquaresFourIcon size={36} weight="thin" className="text-project-hub-ink-faint" />
            <span className="text-sm text-project-hub-ink-subtle">{copy.noCases}</span>
            <span className="text-xs text-project-hub-ink-faint">
              {copy.casesHint}
            </span>
          </div>
        </section>
      </main>
    </div>
  );
}
