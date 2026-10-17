import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Panel } from "../../shared/ui";
import { blenderService, type CloudSession, type JobSummary } from "./service";
import { BlenderSessionWindow } from "./SessionWindow";
import { openBlenderWindow, type BlenderWindowSlot } from "./FloatingWindow";
import { blenderPollDelayMs } from "./pollCadence";

/** The logo opens every viewer directly. Accepted work belongs to the service. */
export function BlenderCloudWindow({ projectSlug, openRequest }: { projectSlug: string; openRequest: number }) {
  const [sessions, setSessions] = useState<CloudSession[]>([]), [jobs, setJobs] = useState<Record<string, JobSummary>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<BlenderWindowSlot[]>([]);
  const seen = useRef(new Set<string>());
  const initialized = useRef(false);
  /** Which `project:openRequest` already opened every viewer, so a cadence change never reopens a dismissed one. */
  const openedFor = useRef<string | null>(null);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  const [error, setError] = useState<string>(), [enabled, setEnabled] = useState<boolean>();
  const [loaded, setLoaded] = useState(false);
  async function refresh(signal: AbortSignal, showAll = false) {
    const data = await blenderService<{ sessions: CloudSession[]; jobs: Record<string, JobSummary>; notices?: Record<string, string> }>("sessions", undefined, signal);
    if (signal.aborted) return;
    const current = data.sessions.filter(s => s.project === projectSlug);
    const toOpen = current.filter(s => showAll || !seen.current.has(s.id) && (initialized.current || !["paused", "expired"].includes(s.state)));
    current.forEach(s => seen.current.add(s.id));
    initialized.current = true;
    setSessions(current); setJobs(data.jobs ?? {}); setNotices(data.notices ?? {}); setLoaded(true); setError(undefined);
    setOpened(windows => toOpen.reduce((result, session) => openBlenderWindow(result, session.id), windows));
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/capabilities", { signal: controller.signal }).then(r => r.json()).then(data => {
      if (!controller.signal.aborted) setEnabled(data.blenderCloud === true);
    }).catch(() => { if (!controller.signal.aborted) setError("Cannot reach the Blender cloud service right now"); });
    return () => controller.abort();
  }, [projectSlug]);
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  // `blenderPollDelayMs` 说明节奏为什么不是固定 5 秒：每次轮询都要花掉服务的 Durable Object 读配额。
  const delay = blenderPollDelayMs(sessions, hidden);
  useEffect(() => {
    if (!enabled) return;
    // 隐藏的标签页**一次都不发**：它看不到任何东西，而每次请求都要花掉服务的 Durable Object
    // 读配额（2026-10-17 整服务 503 就是背景标签页按 5 秒轮询读爆的）。所以先判空、再发。
    if (delay === null) return;
    const controller = new AbortController();
    const failed = () => { if (!controller.signal.aborted) setError("Cannot reach the Blender cloud service right now"); };
    // New AI sessions appear automatically; polling never reopens a dismissed viewer. Only a new
    // logo click or project opens every viewer — a cadence change (idle↔active, hidden↔visible)
    // must not, or a dismissed window would come back every time the tab regains focus.
    const key = `${projectSlug}:${openRequest}`;
    const showAll = openRequest > 0 && openedFor.current !== key;
    openedFor.current = key;
    void refresh(controller.signal, showAll).catch(failed);
    const timer = setInterval(() => { void refresh(controller.signal).catch(failed); }, delay);
    return () => { controller.abort(); clearInterval(timer); };
  }, [projectSlug, enabled, openRequest, delay]);
  const message = error ?? (enabled === false ? "Cloud Blender is temporarily unavailable." : loaded && sessions.length === 0 ? "No Blender tasks yet; tell the AI in chat what you want to make." : undefined);
  return createPortal(<>
    {message && (openRequest > 0 || opened.length > 0) && <Panel role={error ? "alert" : "status"} className="fixed right-4 bottom-20 z-[10000] w-[22rem] max-w-[95vw] p-4 text-sm text-ink">{message}</Panel>}
    {opened.map(({ id, slot }) => {
      const session = sessions.find(s => s.id === id); if (!session) return null;
      return <BlenderSessionWindow key={id} session={session} job={jobs[id]} notice={notices[id]} index={slot}
        onClose={() => setOpened(current => current.filter(window => window.id !== id))} />;
    })}
  </>, document.body);
}
