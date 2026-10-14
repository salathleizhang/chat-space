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
      }).catch(() => { if (!controller.signal.aborted) setError("Failed to reconnect the view; click to watch again. Background tasks keep running."); });
    }
    const timer = setInterval(() => {
      void request(session.id, controller.signal).then(async data => {
        const url = new URL(data.url); url.pathname = `/desktop/${session.id}/__lease/renew`;
        await fetch(url, { credentials: "include", mode: "no-cors", signal: controller.signal });
        if (!controller.signal.aborted) setError(undefined);
      }).catch(() => { if (!controller.signal.aborted) setError("Failed to renew the view credentials; click to watch again. Background tasks keep running."); });
    }, 120_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [session.id, session.epoch, session.state, session.stopReason, session.checkpoint, initial, grant.checkpoint, request]);

  if (session.id !== initial.id || session.epoch !== initial.epoch || session.stopReason) return null;
  if (session.state === "saving") return <p role="status" className="flex min-h-0 flex-1 items-center justify-center bg-black/10 text-sm">Saving the project; the view will resume automatically when it finishes…</p>;
  if (session.state !== "ready") return null;
  return <>
    {session.checkpoint === grant.checkpoint ? <iframe src={grant.url} title="Cloud Blender live view" className="min-h-0 w-full flex-1 border-0 bg-black" allow="fullscreen" /> :
      <p role="status" className="flex min-h-0 flex-1 items-center justify-center bg-black/10 text-sm">Reconnecting to the Blender view…</p>}
    {error && <p role="alert" className="text-sm">{error}</p>}
  </>;
}
