import { useEffect, useRef, useState } from "react";
import { blenderService, type CloudSession } from "./service";

export type DesktopViewGrant = { id: string; epoch: number; url: string; checkpoint: string | null };
type RequestGrant = (id: string, signal: AbortSignal) => Promise<{ url: string }>;
const requestGrant: RequestGrant = (id, signal) => blenderService(`sessions/${id}/desktop`, {}, signal);

/** Read-only batch streams survive intermediate saves. Editor checkpoints revoke
 * the old socket and require a fresh grant before viewing resumes. */
export function BlenderDesktopView({ session, initial, request = requestGrant, onPreview, readOnly = false }: {
  session: CloudSession; initial: DesktopViewGrant; request?: RequestGrant; onPreview?: (image: string) => void; readOnly?: boolean;
}) {
  const [grant, setGrant] = useState(initial), [error, setError] = useState<string>();
  const iframe = useRef<HTMLIFrameElement>(null), attempts = useRef(0);
  const [connected, setConnected] = useState(false), [reconnecting, setReconnecting] = useState(false);
  const [lastFrame, setLastFrame] = useState<string>();
  const viewable = !session.stopReason && (session.state === "ready" || readOnly && session.state === "saving");
  useEffect(() => setLastFrame(undefined), [session.id, session.epoch]);
  useEffect(() => {
    if (!viewable) return;
    const controller = new AbortController();
    let waitingSince = Date.now(), displaying = false, retrying = false, painted = false;
    setConnected(false);
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== new URL(grant.url).origin ||
          event.data?.type !== "chatspace-blender-display" || event.data.session !== session.id) return;
      if (event.data.status !== "connected" && event.data.status !== "connecting") return;
      const image = event.data.preview;
      const validFrame = typeof image === "string" && image.length <= 250_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image);
      if (event.data.status === "connected" && validFrame) {
        painted = true; setLastFrame(image); onPreview?.(image);
      }
      const next = event.data.status === "connected" && painted;
      if (displaying && !next) waitingSince = Date.now();
      displaying = next; setConnected(next);
      if (next) { attempts.current = 0; setError(undefined); }
    };
    const check = () => {
      if (displaying || retrying || Date.now() - waitingSince < 25_000 || attempts.current >= 3) return;
      retrying = true; attempts.current++; setReconnecting(true);
      void request(session.id, controller.signal).then(data => {
        if (!controller.signal.aborted) { setGrant({ ...initial, url: data.url, checkpoint: session.checkpoint }); setReconnecting(false); }
      }).catch(() => {
        if (!controller.signal.aborted) { retrying = false; waitingSince = Date.now(); setReconnecting(false); setError("The live display is disconnected; reconnect the view. Modeling continues in the cloud."); }
      });
    };
    window.addEventListener("message", receive); window.addEventListener("focus", check);
    const timer = setInterval(check, 1_000);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("message", receive); window.removeEventListener("focus", check); };
  }, [session.id, session.epoch, viewable, grant.url, request, onPreview]);
  useEffect(() => {
    if (!viewable || session.id !== initial.id || session.epoch !== initial.epoch) return;
    const controller = new AbortController();
    if (session.checkpoint !== grant.checkpoint) {
      if (readOnly) setGrant(value => ({ ...value, checkpoint: session.checkpoint }));
      else {
      void request(session.id, controller.signal).then(data => {
        if (!controller.signal.aborted) { setGrant({ ...initial, url: data.url, checkpoint: session.checkpoint }); setError(undefined); }
      }).catch(() => { if (!controller.signal.aborted) setError("Failed to reconnect the view; click to watch again. Background tasks keep running."); });
      }
    }
    return () => controller.abort();
  }, [session.id, session.epoch, viewable, session.checkpoint, initial, grant.checkpoint, request, readOnly]);
  // Checkpoints must not restart the renewal clock: frequent autosaves otherwise
  // prevent this interval from ever firing before the five-minute cookie expires.
  useEffect(() => {
    if (!viewable) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void request(session.id, controller.signal).then(async data => {
        const url = new URL(data.url); url.pathname = `/desktop/${session.id}/__lease/renew`;
        await fetch(url, { credentials: "include", mode: "no-cors", signal: controller.signal });
        if (!controller.signal.aborted) setError(undefined);
      }).catch(() => { if (!controller.signal.aborted) setError("Failed to renew the view credentials; click to watch again. Background tasks keep running."); });
    }, 120_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [session.id, session.epoch, viewable, request]);

  if (session.id !== initial.id || session.epoch !== initial.epoch || session.stopReason) return null;
  if (session.state === "saving" && !readOnly) return <p role="status" className="flex min-h-0 flex-1 items-center justify-center bg-black/10 text-sm">Saving the project; the view will resume automatically when it finishes…</p>;
  if (!viewable) return null;
  return <>
    {(readOnly || session.checkpoint === grant.checkpoint) && !reconnecting ? <iframe ref={iframe} src={grant.url} title="Cloud Blender live view" className="min-h-0 w-full flex-1 border-0 bg-black" allow="fullscreen" /> :
      <p role="status" className="flex min-h-0 flex-1 items-center justify-center bg-black/10 text-sm">Reconnecting to the Blender view…</p>}
    {!connected && lastFrame && <img src={lastFrame} alt="Last received Blender frame while reconnecting" className="pointer-events-none absolute inset-0 h-full w-full bg-black object-contain" />}
    {!connected && <p role="status" className="pointer-events-none absolute inset-x-2 bottom-2 rounded bg-black/80 p-2 text-center text-xs text-white">{lastFrame ? "Reconnecting to the live display; showing the last received frame…" : "Connecting to the live Blender display…"}</p>}
    {error && <p role="alert" className="text-sm">{error}</p>}
  </>;
}
