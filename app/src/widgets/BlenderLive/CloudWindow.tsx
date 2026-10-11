import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { Panel, Button } from "../../shared/ui";
import { blenderService, sessionLabels, type CloudSession, type JobSummary } from "./service";
import { durableBlenderRequest, pendingBlenderRequest, type BatchRequest } from "./outbox";
import { BlenderSessionWindow } from "./SessionWindow";
import { openBlenderWindow, type BlenderWindowSlot } from "./FloatingWindow";
type DailyBudget = { runtime: { usedAndReservedMs: number; limitMs: number }; modelCalls: { used: number; limit: number } };

/** Watching is disposable. Accepted work belongs to the durable service. */
export function BlenderCloudWindow({ projectSlug, open, onClose, onImported }: { projectSlug: string; open: boolean; onClose: () => void; onImported: () => void }) {
  const [sessions, setSessions] = useState<CloudSession[]>([]), [jobs, setJobs] = useState<Record<string, JobSummary>>({});
  const [opened, setOpened] = useState<BlenderWindowSlot[]>([]);
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [enabled, setEnabled] = useState<boolean>();
  const [prompts, setPrompts] = useState(""), [parallel, setParallel] = useState(3);
  const [owner, setOwner] = useState<string>(), [pendingBatch, setPendingBatch] = useState<BatchRequest>();
  const [budget, setBudget] = useState<DailyBudget>(), [notices, setNotices] = useState<Record<string, string>>({});
  function openSession(session: CloudSession) {
    setSessions(current => current.some(s => s.id === session.id) ? current : [...current, session]);
    setOpened(current => openBlenderWindow(current, session.id));
  }
  async function refresh(signal?: AbortSignal) {
    const data = await blenderService<{ owner: string; sessions: CloudSession[]; jobs: Record<string, JobSummary>; budget?: DailyBudget; notices?: Record<string, string> }>("sessions", undefined, signal);
    const pending = await pendingBlenderRequest(data.owner, projectSlug, "batch");
    if (!signal?.aborted) {
      setOwner(data.owner); setSessions(data.sessions.filter(s => s.project === projectSlug)); setJobs(data.jobs ?? {});
      setBudget(data.budget); setNotices(data.notices ?? {});
      setPendingBatch(pending?.body as BatchRequest | undefined);
      if (pending) { const batch = pending.body as BatchRequest; setPrompts(batch.items.map(i => i.prompt).join("\n")); setParallel(batch.concurrency); }
    }
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
  async function act(action: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await action(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "请求失败，请刷新状态后重试"); }
    finally { setBusy(false); }
  }
  const lines = prompts.split("\n").map(p => p.trim()).filter(Boolean);
  return createPortal(<>
    {open && <Panel className="fixed top-20 right-4 z-[10000] flex max-h-[80vh] w-[26rem] max-w-[95vw] flex-col overflow-hidden text-ink">
    <div className="flex items-center justify-between gap-4 p-4"><strong>Blender 窗口管理</strong><Button size="sm" variant="ghost" onClick={onClose}>收起管理</Button></div>
    {budget && <p className="px-4 pb-3 text-xs text-ink-muted">今日运行额度已用/预留 {Math.ceil(budget.runtime.usedAndReservedMs / 60_000)} / {budget.runtime.limitMs / 60_000} 分钟；模型调用 {budget.modelCalls.used} / {budget.modelCalls.limit} 次。北京时间 08:00 重置。</p>}
    {enabled === false ? <p className="px-4 pb-4 text-sm">云服务正在部署，尚未开放分配。原有项目和聊天仍可使用。</p> : <>
      <div className="min-h-0 space-y-3 overflow-y-auto px-4 pb-4">
        <Button size="sm" disabled={busy || !enabled || !owner} onClick={() => void act(async () => {
          const data = await durableBlenderRequest<{ session: CloudSession }>(owner!, projectSlug, "create", "sessions", () => ({ project: projectSlug, requestId: crypto.randomUUID() }));
          openSession(data.session); onClose();
        })}>新建 Blender 窗口</Button>
        <p className="text-xs text-ink-muted">每个 Blender 一个独立窗口，可拖动、调整大小、最大化或全屏。关闭窗口只关闭画面；停止运行请点“保存并暂停”。</p>
        {sessions.map(s => <div key={s.id} className="flex items-center gap-2 rounded-lg border border-line p-2 text-xs">
          <div className="min-w-0 flex-1"><span className="block truncate">{jobs[s.id]?.label ?? `Blender ${s.id.slice(0, 6)}`}</span>
            <span>{jobs[s.id]?.state === "waiting-user" ? "等待回答" : sessionLabels[s.state]}</span></div>
          <Button size="sm" disabled={opened.some(window => window.id === s.id)} onClick={() => { openSession(s); onClose(); }}>{opened.some(window => window.id === s.id) ? "已打开" : "打开窗口"}</Button>
        </div>)}
          <details><summary className="cursor-pointer text-sm">批量建模</summary>
            <p className="my-2 text-xs">每行一项要求。运行实例为 8 核 / 32 GiB，每项最长 60 分钟；算力、模型调用及存储按实际用量收费。</p>
            <textarea aria-label="批量建模要求" value={prompts} disabled={busy || Boolean(pendingBatch)} onChange={e => setPrompts(e.target.value)} rows={4} className="w-full rounded-lg border p-2 text-sm" placeholder={"制作一张木桌\n制作一把椅子\n制作一盏台灯"} />
            <label className="block text-xs">同时运行 <select aria-label="建模并行数" value={parallel} disabled={busy || Boolean(pendingBatch)} onChange={e => setParallel(Number(e.target.value))}>{[1, 2, 3].map(n => <option key={n}>{n}</option>)}</select> 项，其余排队</label>
            <Button size="sm" disabled={busy || !enabled || !owner || lines.length < 1 || lines.length > 100} onClick={() => void act(async () => {
              const data = await durableBlenderRequest<{ sessions: CloudSession[] }>(owner!, projectSlug, "batch", "batches", () => ({ id: crypto.randomUUID(), project: projectSlug, concurrency: parallel, items: lines.map((prompt, i) => ({ id: `item-${i}`, label: prompt.slice(0, 60), prompt })) }));
              setPendingBatch(undefined); setPrompts(""); data.sessions.slice(0, parallel).forEach(openSession); onClose();
            })}>{pendingBatch ? "用同一请求重试提交" : `提交 ${lines.length} 项`}</Button>
          </details>
      </div>
    </>}
    {error && <p role="alert" className="px-4 pb-4 text-sm">{error}</p>}
  </Panel>}
    {opened.map(({ id, slot }) => {
      const session = sessions.find(s => s.id === id); if (!session) return null;
      return <BlenderSessionWindow key={id} session={session} job={jobs[id]} notice={notices[id]} owner={owner} projectSlug={projectSlug} index={slot}
        onClose={() => setOpened(current => current.filter(window => window.id !== id))} onImported={onImported} onOpen={openSession} refresh={refresh} />;
    })}
  </>, document.body);
}
