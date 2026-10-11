import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { Panel } from "../../shared/ui";
import { blenderService, type CloudSession, type JobSummary } from "./service";
import { BlenderSessionWindow } from "./SessionWindow";
import { openBlenderWindow, type BlenderWindowSlot } from "./FloatingWindow";

/** The logo opens every viewer directly. Accepted work belongs to the service. */
export function BlenderCloudWindow({ projectSlug, openRequest }: { projectSlug: string; openRequest: number }) {
  const [sessions, setSessions] = useState<CloudSession[]>([]), [jobs, setJobs] = useState<Record<string, JobSummary>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<BlenderWindowSlot[]>([]);
  const seen = useRef(new Set<string>());
  const [error, setError] = useState<string>(), [enabled, setEnabled] = useState<boolean>();
  const [loaded, setLoaded] = useState(false);
  async function refresh(signal: AbortSignal, showAll = false) {
    const data = await blenderService<{ sessions: CloudSession[]; jobs: Record<string, JobSummary>; notices?: Record<string, string> }>("sessions", undefined, signal);
    if (signal.aborted) return;
    const current = data.sessions.filter(s => s.project === projectSlug);
    const toOpen = current.filter(s => showAll || !seen.current.has(s.id));
    current.forEach(s => seen.current.add(s.id));
    setSessions(current); setJobs(data.jobs ?? {}); setNotices(data.notices ?? {}); setLoaded(true); setError(undefined);
    setOpened(windows => toOpen.reduce((result, session) => openBlenderWindow(result, session.id), windows));
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/capabilities", { signal: controller.signal }).then(r => r.json()).then(data => {
      if (!controller.signal.aborted) setEnabled(data.blenderCloud === true);
    }).catch(() => { if (!controller.signal.aborted) setError("暂时无法连接 Blender 云服务"); });
    return () => controller.abort();
  }, [projectSlug]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const failed = () => { if (!controller.signal.aborted) setError("暂时无法连接 Blender 云服务"); };
    void refresh(controller.signal, true).catch(failed);
    // New AI sessions appear automatically; polling never reopens a dismissed viewer.
    const timer = setInterval(() => { void refresh(controller.signal).catch(failed); }, 5_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [projectSlug, enabled, openRequest]);
  const message = error ?? (enabled === false ? "暂时无法使用云端 Blender。" : loaded && sessions.length === 0 ? "还没有 Blender 任务，在聊天中告诉 AI 你想制作什么。" : undefined);
  return createPortal(<>
    {message && <Panel role={error ? "alert" : "status"} className="fixed right-4 bottom-20 z-[10000] w-[22rem] max-w-[95vw] p-4 text-sm text-ink">{message}</Panel>}
    {opened.map(({ id, slot }) => {
      const session = sessions.find(s => s.id === id); if (!session) return null;
      return <BlenderSessionWindow key={id} session={session} job={jobs[id]} notice={notices[id]} index={slot}
        onClose={() => setOpened(current => current.filter(window => window.id !== id))} />;
    })}
  </>, document.body);
}
