import { useCallback, useEffect, useState } from "react";
import { BlenderFloatingWindow } from "./FloatingWindow";
import { BlenderDesktopView, type DesktopViewGrant } from "./DesktopView";
import { blenderService, sessionLabels, type CloudSession, type JobSummary } from "./service";

/** Each session owns its stream; business actions belong to the AI tools. */
export function BlenderSessionWindow({ session, job, notice, index, onClose }: {
  session: CloudSession; job?: JobSummary; notice?: string; index: number; onClose: () => void;
}) {
  const [grant, setGrant] = useState<DesktopViewGrant>(), [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<string>();
  const readOnly = Boolean(job);
  const receivePreview = useCallback((image: string) => setPreview(image), []);
  useEffect(() => { setPreview(undefined); }, [session.id, session.epoch]);
  useEffect(() => {
    if (!["ready", "saving"].includes(session.state) || session.stopReason) { setGrant(undefined); return; }
    if (grant && (grant.epoch !== session.epoch || grant.id !== session.id)) { setGrant(undefined); return; }
    if (session.state !== "ready" && !(readOnly && session.state === "saving") || grant) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void blenderService<{ url: string }>(`sessions/${session.id}/desktop`, {}, controller.signal).then(data => {
      if (!controller.signal.aborted) { setGrant({ id: session.id, epoch: session.epoch, url: data.url, checkpoint: session.checkpoint }); setError(undefined); }
    }).catch(e => { if (!controller.signal.aborted) {
      setError(e instanceof Error ? e.message : "Failed to connect the view");
      timer = setTimeout(() => setRetry(value => value + 1), Math.min(30_000, 2_000 * 2 ** Math.min(retry, 4)));
    } });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [session.id, session.epoch, session.state, session.stopReason, grant?.epoch, retry, readOnly]);
  const title = job?.label ?? `Blender ${session.id.slice(0, 6)}`;
  return <BlenderFloatingWindow title={title} status={job?.state === "waiting-user" ? "Waiting for an answer" : job?.state === "planning" ? "Planning next step" : sessionLabels[session.state]} index={index} onClose={onClose}>
    {!grant && preview && <img src={preview} alt="Last frame from the cloud Blender desktop" className="absolute inset-0 h-full w-full bg-black object-contain" />}
    {grant ? <BlenderDesktopView session={session} initial={grant} onPreview={receivePreview} readOnly={readOnly} /> : <div className={`relative flex min-h-0 flex-1 items-center justify-center ${preview ? "items-end bg-transparent pb-3" : "bg-black"} text-xs text-white/70`} role="status">
      <span className={preview ? "rounded bg-black/80 px-2 py-1" : undefined}>
      {session.state === "ready" ? "Connecting to Blender…" : ["paused", "expired"].includes(session.state) ? "The project is saved; waiting to continue the task." : sessionLabels[session.state]}
      </span>
    </div>}
    {notice && <p role="status" className="absolute inset-x-3 top-2 rounded-lg bg-black/90 p-2 text-xs text-white">The daily runtime quota is exhausted; waiting for it to recover.</p>}
    {job?.state === "waiting-user" && <p role="status" className="absolute inset-x-3 top-2 rounded-lg bg-black/90 p-2 text-xs text-white">The task needs more information; tell the AI in chat.</p>}
    {error && <p role="alert" className="absolute inset-x-3 top-2 rounded-lg bg-black/90 p-2 text-xs text-white">{error}</p>}
  </BlenderFloatingWindow>;
}
