import { CubeFocusIcon } from "@phosphor-icons/react/CubeFocus";
import { FolderSimplePlusIcon } from "@phosphor-icons/react/FolderSimplePlus";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { preloadAppDashboard } from "../app/router";
import {
  createProject,
  fetchProjects,
  fetchProjectState,
  libraryUrl,
  type ProjectState,
  type ProjectSummary,
} from "../shared/lib/libraryApi";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
  Input,
  Panel,
} from "../shared/ui";

interface ProjectListItem {
  project: ProjectSummary;
  assetCount: number;
  sourceCount: number;
  previewImages: string[];
}

const FOLDER_TONES = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
type FolderTone = (typeof FOLDER_TONES)[number];
const FOLDER_CARD_VARIANTS = ["yellow", "blue", "coral"] as const;

const IMAGE_FILE_PATTERN = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

function projectPreviewImages(projectSlug: string, state: ProjectState): string[] {
  const images = new Set<string>();
  const addImage = (path: string) => {
    if (!IMAGE_FILE_PATTERN.test(path)) return;
    images.add(path.includes("/") ? path : `projects/${projectSlug}/source/${path}`);
  };

  for (const source of state.sources.toReversed()) addImage(source);
  for (const asset of state.assets.toReversed()) {
    for (const sourceImage of asset.identity?.sourceImages.toReversed() ?? []) {
      addImage(sourceImage);
    }
    for (const file of asset.files.toReversed()) {
      if (file.startsWith(".")) continue;
      addImage(`projects/${projectSlug}/assets/${asset.slug}/${file}`);
    }
  }

  return Array.from(images).slice(0, FOLDER_CARD_VARIANTS.length);
}

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

async function loadProjectItems(): Promise<ProjectListItem[]> {
  const projects = await fetchProjects();
  const sorted = projects.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // 单个项目的 state 读取失败（目录损坏/单个 JSON 异常）只降级为 0 资产卡片，
  // 不能拖垮整个入口页让健康项目也进不去。
  const results = await Promise.allSettled(
    sorted.map(async (project) => {
      const state = await fetchProjectState(project.slug);
      return {
        project,
        assetCount: state?.assets.length ?? 0,
        sourceCount: state?.sources.length ?? 0,
        previewImages: state ? projectPreviewImages(project.slug, state) : [],
      };
    }),
  );
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : { project: sorted[index]!, assetCount: 0, sourceCount: 0, previewImages: [] },
  );
}

function folderToneFor(projectKey: string): FolderTone {
  let hash = 2_166_136_261;
  for (const character of projectKey) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return FOLDER_TONES[(hash >>> 0) % FOLDER_TONES.length] ?? "blue";
}

function ProjectFolderLogo({
  projectKey,
  projectName,
  previewImages,
}: {
  projectKey: string;
  projectName: string;
  previewImages: string[];
}) {
  const initial = Array.from(projectName.trim())[0] ?? "?";
  const tone = folderToneFor(projectKey);

  return (
    <span
      className={`project-folder-logo project-folder-logo--${tone}`}
      aria-hidden="true"
    >
      <span className="project-folder-back" />
      {FOLDER_CARD_VARIANTS.map((variant, index) => (
        <span
          key={variant}
          className={`project-folder-card project-folder-card--${variant}`}
        >
          {previewImages[index] && (
            <img
              className="project-folder-card-image"
              src={libraryUrl(previewImages[index])}
              alt=""
              draggable="false"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
        </span>
      ))}
      <span className="project-folder-front" />
      <span className="project-folder-monogram">{initial}</span>
    </span>
  );
}

function CreateProjectDialog() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (close: () => void) => {
    const projectName = name.trim();
    if (!projectName || creating) return;
    setCreating(true);
    setError(null);
    try {
      const project = await createProject(projectName);
      close();
      navigate(`/app/${project.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <Dialog
      openOnMount={searchParams.get("create") === "1"}
      trigger={(open) => (
        <Button
          variant="primary"
          icon={FolderSimplePlusIcon}
          onClick={open}
          onMouseEnter={() => void preloadAppDashboard()}
        >
          Create project
        </Button>
      )}
    >
      {(close) => (
        <form
          className="flex w-80 flex-col p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(close);
          }}
        >
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>Each project has its own assets, conversations, and generation tasks.</DialogDescription>
          <Input
            className="mt-4"
            aria-label="Project name"
            placeholder="Project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
          {error && <p className="mt-2 text-xs text-ink">⚠️ {error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || creating}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function ProjectHubPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadProjectItems()
      .then((projects) => {
        if (!cancelled) setItems(projects);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="h-full w-full overflow-y-auto bg-project-hub-canvas text-project-hub-ink">
      {/* 顶栏：与 Agent Dock 同级的液态玻璃胶囊（全应用仅两处 liquid） */}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-10 flex justify-center">
        <Panel
          variant="liquid"
          className="animate-chrome-enter-center pointer-events-auto flex w-[min(56rem,calc(100%-2rem))] items-center justify-between rounded-full! py-2 pr-2 pl-5"
        >
          <div className="flex items-center gap-2">
            <CubeFocusIcon size={24} weight="duotone" className="text-ink-strong" />
            <span className="text-sm font-medium text-ink-strong">ChatSpace</span>
          </div>
          <div className="flex items-center gap-2">
            <CreateProjectDialog />
          </div>
        </Panel>
      </div>

      <main className="animate-chrome-enter mx-auto w-full max-w-5xl px-6 pt-28 pb-16">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-sm font-medium text-project-hub-ink-strong">Projects</h1>
          {!loading && (
            <span className="text-xs text-project-hub-ink-subtle">{items.length} total</span>
          )}
        </div>

        {error && <p className="mb-4 text-sm text-project-hub-ink">⚠️ {error}</p>}

        {loading ? (
          <p className="py-16 text-center text-sm text-project-hub-ink-subtle">
            Loading local projects…
          </p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <FolderSimplePlusIcon
              size={36}
              weight="thin"
              className="text-project-hub-ink-faint"
            />
            <span className="text-sm text-project-hub-ink-subtle">No projects yet</span>
            <span className="text-xs text-project-hub-ink-faint">
              Click “Create project” in the top right to start your first 3D project.
            </span>
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-x-5 gap-y-8">
            {items.map(({ project, assetCount, sourceCount, previewImages }) => (
              <li key={project.slug}>
                <button
                  type="button"
                  className="project-folder-button flex w-full flex-col items-center rounded-surface px-3 pt-3 pb-4 text-center"
                  onClick={() => navigate(`/app/${project.slug}`)}
                  onMouseEnter={() => void preloadAppDashboard()}
                  onFocus={() => void preloadAppDashboard()}
                  aria-label={`Open project ${project.name}`}
                >
                  <ProjectFolderLogo
                    projectKey={project.slug}
                    projectName={project.name}
                    previewImages={previewImages}
                  />
                  <span className="mt-3 w-full">
                    <span className="block truncate text-sm font-semibold text-project-hub-ink-strong">
                      {project.name}
                    </span>
                    <span className="mt-1 block text-xs text-project-hub-ink-subtle">
                      {assetCount} assets · {sourceCount} source images
                    </span>
                    <span className="mt-0.5 block text-xs text-project-hub-ink-faint">
                      {DATE_FORMATTER.format(new Date(project.createdAt))}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
