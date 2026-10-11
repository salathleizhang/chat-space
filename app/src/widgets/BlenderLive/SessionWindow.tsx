import { useEffect, useState } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { Button, Panel } from "../../shared/ui";
import { BlenderFloatingWindow } from "./FloatingWindow";
import { BlenderDesktopView, type DesktopViewGrant } from "./DesktopView";
import { blenderService, sessionLabels, type CloudSession, type JobSummary } from "./service";
import { durableBlenderRequest } from "./outbox";

/** Each session owns its stream and controls; closing a frame only disconnects watching. */
export function BlenderSessionWindow({ session, job, notice, owner, projectSlug, index, onClose, onImported, onOpen, refresh }: {
  session: CloudSession; job?: JobSummary; notice?: string; owner?: string; projectSlug: string; index: number;
  onClose: () => void; onImported: () => void; onOpen: (session: CloudSession) => void; refresh: () => Promise<void>;
}) {
  const [grant, setGrant] = useState<DesktopViewGrant>(), [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const [controls, setControls] = useState(false);
  const [answer, setAnswer] = useState(""), [discardUnknown, setDiscardUnknown] = useState(false);
  useEffect(() => {
    if (!["ready", "saving"].includes(session.state) || session.stopReason) { setGrant(undefined); return; }
    if (grant && (grant.epoch !== session.epoch || grant.id !== session.id)) { setGrant(undefined); return; }
    if (session.state !== "ready" || grant) return;
    const controller = new AbortController();
    void blenderService<{ url: string }>(`sessions/${session.id}/desktop`, {}, controller.signal).then(data => {
      if (!controller.signal.aborted) { setGrant({ id: session.id, epoch: session.epoch, url: data.url, checkpoint: session.checkpoint }); setError(undefined); }
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "连接画面失败"); });
    return () => controller.abort();
  }, [session.id, session.epoch, session.state, session.stopReason, grant?.epoch, attempt]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await action(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "请求失败，请重试"); }
    finally { setBusy(false); }
  }
  const title = job?.label ?? `Blender ${session.id.slice(0, 6)}`;
  return <BlenderFloatingWindow title={title} status={job?.state === "waiting-user" ? "等待回答" : sessionLabels[session.state]} index={index} onClose={onClose}>
    {grant ? <BlenderDesktopView session={session} initial={grant} /> : <div className="flex min-h-0 flex-1 items-center justify-center bg-black text-xs text-white/70" role="status">
      {session.state === "ready" ? "正在连接 Blender…" : ["paused", "expired"].includes(session.state) ? "工程已保存，可从操作菜单恢复。" : sessionLabels[session.state]}
    </div>}
    <Button variant="ghost" size="sm" shape="square" icon={DotsThreeIcon} aria-label="Blender 操作" aria-expanded={controls}
      className="absolute bottom-3 left-3.5 z-20" onClick={() => setControls(v => !v)} />
    {controls && <Panel className="absolute inset-x-3 top-2 bottom-14 z-10 overflow-y-auto !rounded-xl p-3 text-ink">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span role="status">{job?.state === "waiting-user" ? "等待回答" : sessionLabels[session.state]}{job ? " · 只读" : ""}</span>
      {session.state === "ready" && !job && <Button size="sm" disabled={busy || !owner} onClick={() => void act(async () => {
        await durableBlenderRequest(owner!, projectSlug, `export-${session.id}`, `sessions/${session.id}/operations`, () => ({ epoch: session.epoch, key: crypto.randomUUID(), tool: "export_scene", arguments: {} }));
      })}>导出场景</Button>}
      <Button size="sm" disabled={busy} onClick={() => void act(async () => {
        const { importCloudBlenderExports } = await import("../../browser/blenderImports");
        const count = await importCloudBlenderExports(projectSlug, session.id); if (count) onImported();
      })}>领取模型</Button>
      {!session.stopReason && !["paused", "expired"].includes(session.state) && <Button size="sm" disabled={busy} onClick={() => void act(async () => {
        await blenderService(`sessions/${session.id}/end`, { reason: job ? "cancelled" : "ended" }); setGrant(undefined);
      })}>保存并暂停</Button>}
      {session.checkpoint && ["paused", "expired"].includes(session.state) && !job && <Button size="sm" disabled={busy} onClick={() => void act(async () => {
        await blenderService(`sessions/${session.id}/resume`, {});
      })}>恢复工程</Button>}
      {job && ["failed", "cancelled"].includes(job.state) && ["paused", "expired"].includes(session.state) && <Button size="sm" disabled={busy || !owner} onClick={() => void act(async () => {
        const data = await durableBlenderRequest<{ session: CloudSession }>(owner!, projectSlug, `retry-${session.id}`, `sessions/${session.id}/retry`, () => ({ requestId: crypto.randomUUID() })); onOpen(data.session);
      })}>仅重做此项</Button>}
    </div>
    {notice && <p className="px-3 text-xs" role="status">今日运行额度不足，正在等待额度恢复。</p>}
    {job?.error && <p className="max-h-20 overflow-auto break-words px-3 text-xs" role="status">{job.error === "daily_model_call_limit" ? "今日模型调用额度已用完，工程将保存并暂停；额度恢复后可继续。" : job.error}</p>}
    {job?.state === "waiting-user" && ["paused", "expired"].includes(session.state) && session.checkpoint && <div className="space-y-2 px-3 py-2">
      <textarea aria-label="回答建模任务" value={answer} onChange={e => setAnswer(e.target.value)} className="w-full rounded-lg border p-2 text-sm" placeholder="回答后从已保存工程继续" />
      <label className="block text-xs"><input type="checkbox" checked={discardUnknown} onChange={e => setDiscardUnknown(e.target.checked)} /> 执行结果不明时，允许退回最近已保存工程</label>
      <Button size="sm" disabled={busy || !answer.trim()} onClick={() => void act(async () => { await blenderService(`sessions/${session.id}/answer`, { message: answer, discardUnknown }); setAnswer(""); })}>回答并继续</Button>
    </div>}
    {session.state === "ready" && <Button size="sm" disabled={busy} onClick={() => { setGrant(undefined); setAttempt(v => v + 1); }}>重连画面</Button>}
    </Panel>}
    {error && <p role="alert" className="absolute inset-x-3 top-2 z-20 rounded-lg bg-black/90 p-2 text-xs text-white">{error}<Button size="sm" onClick={() => { setError(undefined); setControls(true); }}>打开操作菜单</Button></p>}
  </BlenderFloatingWindow>;
}
