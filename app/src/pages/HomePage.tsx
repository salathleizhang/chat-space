import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CubeFocusIcon } from "@phosphor-icons/react/CubeFocus";
import { FolderSimplePlusIcon } from "@phosphor-icons/react/FolderSimplePlus";
import { SquaresFourIcon } from "@phosphor-icons/react/SquaresFour";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createProject } from "../shared/lib/libraryApi";
import { Button, Input, Panel } from "../shared/ui";

export function HomePage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectName = name.trim();
    if (!projectName || creating) return;

    setCreating(true);
    setError(null);
    try {
      const project = await createProject(projectName);
      navigate(`/app/${project.slug}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
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
          <h1 id="home-title" className="text-3xl font-semibold tracking-tight text-project-hub-ink-strong sm:text-4xl">
            If you can say it, you can model it.
          </h1>
          <p className="mt-3 text-sm text-project-hub-ink-subtle">
            Name your project to start building in ChatSpace.
          </p>

          <Panel className="mt-9 w-full px-3 py-2">
            <form onSubmit={(event) => void submit(event)} className="flex items-center gap-2">
              <Input
                id="home-project-name"
                variant="plain"
                size="lg"
                className="min-w-0 flex-1"
                aria-label="Project name"
                placeholder="Name your new project…"
                value={name}
                onChange={(event) => setName(event.target.value)}
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
                disabled={!name.trim() || creating}
                aria-label={creating ? "Creating project" : "Create project from name"}
              />
            </form>
          </Panel>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-signal">{error}</p>
          ) : (
            <p className="mt-3 text-xs text-project-hub-ink-faint">Press Enter to create your project</p>
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
