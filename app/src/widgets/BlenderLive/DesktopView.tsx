import { useEffect, useState } from "react";
import { blenderService, type CloudSession } from "./service";

export type DesktopViewGrant = { id: string; epoch: number; url: string; checkpoint: string | null };
type RequestGrant = (id: string, signal: AbortSignal) => Promise<{ url: string }>;
const requestGrant: RequestGrant = (id, signal) => blenderService(`sessions/${id}/desktop`, {}, signal);

/** A checkpoint revokes the old socket. Keep watching intent while saving, then
 * obtain a fresh grant, including when polling skipped the brief saving state. */
export function BlenderDesktopView({ session, initial, request = requestGrant }: {
  session: CloudSession; initial: DesktopViewGrant; request?: RequestGrant;
}) {
  const [grant, setGrant] = useState(initial), [error, setError] = useState<string>();
  useEffect(() => {
    if (session.state !== "ready" || session.stopReason || session.id !== initial.id || session.epoch !== initial.epoch) return;
    const controller = new AbortController();
    if (session.checkpoint !== grant.checkpoint) {
      void request(session.id, controller.signal).then(data => {
        if (!controller.signal.aborted) { setGrant({ ...initial, url: data.url, checkpoint: session.checkpoint }); setError(undefined); }
      }).catch(() => { if (!controller.signal.aborted) setError("画面重连失败，可重新点击观看；后台任务继续执行。"); });
    }
    const timer = setInterval(() => {
      void request(session.id, controller.signal).then(async data => {
        const url = new URL(data.url); url.pathname = `/desktop/${session.id}/__lease/renew`;
        await fetch(url, { credentials: "include", mode: "no-cors", signal: controller.signal });
        if (!controller.signal.aborted) setError(undefined);
      }).catch(() => { if (!controller.signal.aborted) setError("画面凭证续期失败，可重新点击观看；后台任务继续执行。"); });
    }, 120_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [session.id, session.epoch, session.state, session.stopReason, session.checkpoint, initial, grant.checkpoint, request]);

  if (session.id !== initial.id || session.epoch !== initial.epoch || session.stopReason) return null;
  if (session.state === "saving") return <p role="status" className="flex aspect-video items-center justify-center bg-black/10 text-sm">正在保存工程，完成后自动恢复画面…</p>;
  if (session.state !== "ready") return null;
  return <>
    {session.checkpoint === grant.checkpoint ? <iframe src={grant.url} title="Cloud Blender live view" className="aspect-video w-full border-0 bg-black" /> :
      <p role="status" className="flex aspect-video items-center justify-center bg-black/10 text-sm">正在重新连接 Blender 画面…</p>}
    {error && <p role="alert" className="text-sm">{error}</p>}
  </>;
}
