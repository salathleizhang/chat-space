import { useEffect, useState } from "react";
import { Panel, Button } from "../../shared/ui";
import { blenderService, sessionLabels, type CloudSession, type JobSummary } from "./service";
import { durableBlenderRequest, pendingBlenderRequest, type BatchRequest } from "./outbox";
import { BlenderDesktopView, type DesktopViewGrant } from "./DesktopView";
type DailyBudget = { runtime: { usedAndReservedMs: number; limitMs: number }; modelCalls: { used: number; limit: number } };

/** Watching is disposable. Accepted work belongs to the durable service. */
export function BlenderCloudWindow({ projectSlug, onClose, onImported }: { projectSlug: string; onClose: () => void; onImported: () => void }) {
  const [sessions, setSessions] = useState<CloudSession[]>([]), [jobs, setJobs] = useState<Record<string, JobSummary>>({});
  const [selected, setSelected] = useState<string>(), [view, setView] = useState<DesktopViewGrant>();
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [enabled, setEnabled] = useState<boolean>();
  const [prompts, setPrompts] = useState(""), [parallel, setParallel] = useState(3), [answer, setAnswer] = useState("");
  const [discardUnknown, setDiscardUnknown] = useState(false);
  const [owner, setOwner] = useState<string>(), [pendingBatch, setPendingBatch] = useState<BatchRequest>();
  const [budget, setBudget] = useState<DailyBudget>(), [notices, setNotices] = useState<Record<string, string>>({});
  const session = sessions.find(s => s.id === selected), job = selected ? jobs[selected] : undefined;
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
  useEffect(() => {
    if (view && (view.id !== selected || session?.epoch !== view.epoch || !["ready", "saving"].includes(session?.state ?? "") || session?.stopReason)) setView(undefined);
  }, [selected, session?.epoch, session?.state, session?.stopReason, view]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await action(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "请求失败，请刷新状态后重试"); }
    finally { setBusy(false); }
  }
  const lines = prompts.split("\n").map(p => p.trim()).filter(Boolean);
  return <Panel className="flex max-h-[80vh] w-[46rem] max-w-[95vw] flex-col overflow-hidden">
    <div className="flex items-center justify-between gap-4 p-4"><strong>Blender 云工作台</strong><Button size="sm" variant="ghost" onClick={onClose}>关闭观看</Button></div>
    {budget && <p className="px-4 pb-3 text-xs text-ink-muted">今日运行额度已用/预留 {Math.ceil(budget.runtime.usedAndReservedMs / 60_000)} / {budget.runtime.limitMs / 60_000} 分钟；模型调用 {budget.modelCalls.used} / {budget.modelCalls.limit} 次。北京时间 08:00 重置。</p>}
    {enabled === false ? <p className="px-4 pb-4 text-sm">云服务正在部署，尚未开放分配。原有项目和聊天仍可使用。</p> : <>
      <div className="flex min-h-0 flex-1 gap-3 overflow-y-auto px-4 pb-4">
        <div className="w-44 shrink-0 space-y-2">
          <Button size="sm" disabled={busy || !enabled || !owner} onClick={() => void act(async () => {
            const data = await durableBlenderRequest<{ session: CloudSession }>(owner!, projectSlug, "create", "sessions", () => ({ project: projectSlug, requestId: crypto.randomUUID() }));
            setSelected(data.session.id);
          })}>新建 Blender</Button>
          {sessions.map(s => <button key={s.id} onClick={() => { setSelected(s.id); setAnswer(""); }} aria-pressed={selected === s.id}
            className={`block w-full rounded-lg p-2 text-left text-xs ${selected === s.id ? "bg-ink-strong/10" : "hover:bg-ink-strong/5"}`}>
            <span className="block truncate">{jobs[s.id]?.label ?? `Blender ${s.id.slice(0, 6)}`}</span>
            <span>{jobs[s.id]?.state === "waiting-user" ? "等待回答" : sessionLabels[s.state]}</span>
          </button>)}
          {!sessions.length && <p className="text-xs text-ink-muted">打开面板不会创建沙盒。</p>}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          {session ? <>
            <p className="text-sm">{job?.label ?? "独立 Blender"} · {sessionLabels[session.state]}</p>
            {notices[session.id] && <p className="text-xs" role="status">今日运行额度不足，正在等待额度恢复。</p>}
            <p className="text-xs text-ink-muted">{job ? "画面只读，关闭观看后后台任务继续执行。" : "手动操作会保持活跃；五分钟无操作后保存并暂停，单次运行最长六十分钟。"}</p>
            {session.state === "ready" && <Button size="sm" disabled={busy} onClick={() => void act(async () => {
              const data = await blenderService<{ url: string }>(`sessions/${session.id}/desktop`, {});
              setView({ id: session.id, epoch: session.epoch, url: data.url, checkpoint: session.checkpoint });
            })}>观看画面</Button>}
            {session.state === "ready" && !job && <Button size="sm" disabled={busy} onClick={() => void act(async () => {
              await durableBlenderRequest(owner!, projectSlug, `export-${session.id}`, `sessions/${session.id}/operations`, () => ({ epoch: session.epoch, key: crypto.randomUUID(), tool: "export_scene", arguments: {} }));
            })}>导出当前场景</Button>}
            {view && <BlenderDesktopView key={view.url} session={session} initial={view} />}
            {!session.stopReason && !["paused", "expired"].includes(session.state) && <Button size="sm" disabled={busy} onClick={() => void act(async () => {
              await blenderService(`sessions/${session.id}/end`, { reason: job ? "cancelled" : "ended" }); setView(undefined);
            })}>结束此项，保存后暂停</Button>}
            {session.checkpoint && ["paused", "expired"].includes(session.state) && !job && <Button size="sm" disabled={busy} onClick={() => void act(async () => { await blenderService(`sessions/${session.id}/resume`, {}); })}>恢复已保存工程</Button>}
            {job?.error && <p className="break-words text-sm" role="status">{job.error === "daily_model_call_limit" ? "今日模型调用额度已用完，工程将保存并暂停；额度恢复后可继续。" : job.error}</p>}
            {job?.state === "waiting-user" && ["paused", "expired"].includes(session.state) && session.checkpoint && <>
              <textarea aria-label="回答建模任务" value={answer} onChange={e => setAnswer(e.target.value)} className="w-full rounded-lg border p-2 text-sm" placeholder="回答后从已保存工程继续" />
              <label className="block text-xs"><input type="checkbox" checked={discardUnknown} onChange={e => setDiscardUnknown(e.target.checked)} /> 执行结果不明时，允许退回最近已保存工程</label>
              <Button size="sm" disabled={busy || !answer.trim()} onClick={() => void act(async () => { await blenderService(`sessions/${session.id}/answer`, { message: answer, discardUnknown }); setAnswer(""); })}>回答并继续</Button>
            </>}
            {job && ["failed", "cancelled"].includes(job.state) && ["paused", "expired"].includes(session.state) && <Button size="sm" disabled={busy} onClick={() => void act(async () => {
              const data = await durableBlenderRequest<{ session: CloudSession }>(owner!, projectSlug, `retry-${session.id}`, `sessions/${session.id}/retry`, () => ({ requestId: crypto.randomUUID() })); setSelected(data.session.id);
            })}>仅重做此项（新尝试）</Button>}
            <Button size="sm" disabled={busy} onClick={() => void act(async () => {
              const { importCloudBlenderExports } = await import("../../browser/blenderImports");
              const count = await importCloudBlenderExports(projectSlug, session.id); if (count) onImported();
            })}>领取已完成模型</Button>
          </> : <p className="text-sm">选择会话查看进度。关闭观看窗口后，已提交的任务会继续执行。</p>}
          <details><summary className="cursor-pointer text-sm">批量建模</summary>
            <p className="my-2 text-xs">每行一项要求。运行实例为 8 核 / 32 GiB，每项最长 60 分钟；算力、模型调用及存储按实际用量收费。</p>
            <textarea aria-label="批量建模要求" value={prompts} disabled={busy || Boolean(pendingBatch)} onChange={e => setPrompts(e.target.value)} rows={4} className="w-full rounded-lg border p-2 text-sm" placeholder={"制作一张木桌\n制作一把椅子\n制作一盏台灯"} />
            <label className="block text-xs">同时运行 <select aria-label="建模并行数" value={parallel} disabled={busy || Boolean(pendingBatch)} onChange={e => setParallel(Number(e.target.value))}>{[1, 2, 3].map(n => <option key={n}>{n}</option>)}</select> 项，其余排队</label>
            <Button size="sm" disabled={busy || !enabled || !owner || lines.length < 1 || lines.length > 100} onClick={() => void act(async () => {
              const data = await durableBlenderRequest<{ sessions: CloudSession[] }>(owner!, projectSlug, "batch", "batches", () => ({ id: crypto.randomUUID(), project: projectSlug, concurrency: parallel, items: lines.map((prompt, i) => ({ id: `item-${i}`, label: prompt.slice(0, 60), prompt })) }));
              setPendingBatch(undefined); setPrompts(""); setSelected(data.sessions[0]?.id);
            })}>{pendingBatch ? "用同一请求重试提交" : `提交 ${lines.length} 项`}</Button>
          </details>
        </div>
      </div>
    </>}
    {error && <p role="alert" className="px-4 pb-4 text-sm">{error}</p>}
  </Panel>;
}
