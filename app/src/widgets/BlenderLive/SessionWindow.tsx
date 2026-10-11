import { useEffect, useState } from "react";
import { BlenderFloatingWindow } from "./FloatingWindow";
import { BlenderDesktopView, type DesktopViewGrant } from "./DesktopView";
import { blenderService, sessionLabels, type CloudSession, type JobSummary } from "./service";

/** Each session owns its stream; business actions belong to the AI tools. */
export function BlenderSessionWindow({ session, job, notice, index, onClose }: {
  session: CloudSession; job?: JobSummary; notice?: string; index: number; onClose: () => void;
}) {
  const [grant, setGrant] = useState<DesktopViewGrant>(), [error, setError] = useState<string>();
  useEffect(() => {
    if (!["ready", "saving"].includes(session.state) || session.stopReason) { setGrant(undefined); return; }
    if (grant && (grant.epoch !== session.epoch || grant.id !== session.id)) { setGrant(undefined); return; }
    if (session.state !== "ready" || grant) return;
    const controller = new AbortController();
    void blenderService<{ url: string }>(`sessions/${session.id}/desktop`, {}, controller.signal).then(data => {
      if (!controller.signal.aborted) { setGrant({ id: session.id, epoch: session.epoch, url: data.url, checkpoint: session.checkpoint }); setError(undefined); }
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "连接画面失败"); });
    return () => controller.abort();
  }, [session.id, session.epoch, session.state, session.stopReason, grant?.epoch]);
  const title = job?.label ?? `Blender ${session.id.slice(0, 6)}`;
  return <BlenderFloatingWindow title={title} status={job?.state === "waiting-user" ? "等待回答" : sessionLabels[session.state]} index={index} onClose={onClose}>
    {grant ? <BlenderDesktopView session={session} initial={grant} /> : <div className="flex min-h-0 flex-1 items-center justify-center bg-black text-xs text-white/70" role="status">
      {session.state === "ready" ? "正在连接 Blender…" : ["paused", "expired"].includes(session.state) ? "工程已保存，等待继续任务。" : sessionLabels[session.state]}
    </div>}
    {notice && <p role="status" className="absolute inset-x-3 top-2 rounded-lg bg-black/90 p-2 text-xs text-white">今日运行额度不足，正在等待额度恢复。</p>}
    {job?.state === "waiting-user" && <p role="status" className="absolute inset-x-3 top-2 rounded-lg bg-black/90 p-2 text-xs text-white">任务需要补充信息，请在聊天中告诉 AI。</p>}
    {error && <p role="alert" className="absolute inset-x-3 top-2 rounded-lg bg-black/90 p-2 text-xs text-white">{error}</p>}
  </BlenderFloatingWindow>;
}
