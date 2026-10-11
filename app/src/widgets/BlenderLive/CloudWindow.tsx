import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { Panel, Button } from "../../shared/ui";
import { blenderService, sessionLabels, type CloudSession, type JobSummary } from "./service";
import { BlenderSessionWindow } from "./SessionWindow";
import { openBlenderWindow, type BlenderWindowSlot } from "./FloatingWindow";

/** Watching is disposable. Accepted work belongs to the durable service. */
export function BlenderCloudWindow({ projectSlug, open, onClose }: { projectSlug: string; open: boolean; onClose: () => void }) {
  const [sessions, setSessions] = useState<CloudSession[]>([]), [jobs, setJobs] = useState<Record<string, JobSummary>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<BlenderWindowSlot[]>([]);
  const [error, setError] = useState<string>(), [enabled, setEnabled] = useState<boolean>();
  function openSession(session: CloudSession) {
    setSessions(current => current.some(s => s.id === session.id) ? current : [...current, session]);
    setOpened(current => openBlenderWindow(current, session.id));
  }
  async function refresh(signal?: AbortSignal) {
    const data = await blenderService<{ sessions: CloudSession[]; jobs: Record<string, JobSummary>; notices?: Record<string, string> }>("sessions", undefined, signal);
    if (!signal?.aborted) { setSessions(data.sessions.filter(s => s.project === projectSlug)); setJobs(data.jobs ?? {}); setNotices(data.notices ?? {}); }
  }

  useEffect(() => {
    const controller = new AbortController(); let available = false;
    void fetch("/api/capabilities", { signal: controller.signal }).then(r => r.json()).then(async data => {
      if (controller.signal.aborted) return;
      available = data.blenderCloud === true; setEnabled(available); if (available) await refresh(controller.signal);
    }).catch(() => { if (!controller.signal.aborted) setError("暂时无法连接 Blender 云服务"); });
    // Display refresh only. Server supervision continues when the browser closes.
    const timer = setInterval(() => { if (available) void refresh(controller.signal).catch(() => {}); }, 5_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [projectSlug]);
  return createPortal(<>
    {open && <Panel className="fixed top-20 right-4 z-[10000] flex max-h-[80vh] w-[26rem] max-w-[95vw] flex-col overflow-hidden text-ink">
    <div className="flex items-center justify-between gap-4 p-4"><strong>Blender 窗口管理</strong><Button size="sm" variant="ghost" onClick={onClose}>收起管理</Button></div>
    {enabled === false ? <p className="px-4 pb-4 text-sm">云服务正在部署，尚未开放分配。原有项目和聊天仍可使用。</p> : <>
      <div className="min-h-0 space-y-3 overflow-y-auto px-4 pb-4">
        <p className="text-xs text-ink-muted">建模、导出、保存和恢复由 AI 处理。这里可以打开独立小窗观看；关闭小窗只关闭画面。</p>
        {sessions.length === 0 && <p className="text-sm">在聊天中告诉 AI 你想用 Blender 制作什么。</p>}
        {sessions.map(s => <div key={s.id} className="flex items-center gap-2 rounded-lg border border-line p-2 text-xs">
          <div className="min-w-0 flex-1"><span className="block truncate">{jobs[s.id]?.label ?? `Blender ${s.id.slice(0, 6)}`}</span>
            <span>{jobs[s.id]?.state === "waiting-user" ? "等待回答" : sessionLabels[s.state]}</span></div>
          <Button size="sm" disabled={opened.some(window => window.id === s.id)} onClick={() => { openSession(s); onClose(); }}>{opened.some(window => window.id === s.id) ? "已打开" : "打开窗口"}</Button>
        </div>)}

      </div>
    </>}
    {error && <p role="alert" className="px-4 pb-4 text-sm">{error}</p>}
  </Panel>}
    {opened.map(({ id, slot }) => {
      const session = sessions.find(s => s.id === id); if (!session) return null;
      return <BlenderSessionWindow key={id} session={session} job={jobs[id]} notice={notices[id]} index={slot}
        onClose={() => setOpened(current => current.filter(window => window.id !== id))} />;
    })}
  </>, document.body);
}
