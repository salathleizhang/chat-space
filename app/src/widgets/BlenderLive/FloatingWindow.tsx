import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowsInIcon, ArrowsOutIcon, CornersOutIcon, XIcon } from "@phosphor-icons/react";
import { Badge, Button, Panel } from "../../shared/ui";

let nextLayer = 100;
export type BlenderWindowSlot = { id: string; slot: number };
/** Reuse vacant positions without moving the remaining live windows. */
export function openBlenderWindow(current: BlenderWindowSlot[], id: string): BlenderWindowSlot[] {
  if (current.some(window => window.id === id)) return current;
  const occupied = new Set(current.map(window => window.slot));
  let slot = 0; while (occupied.has(slot)) slot++;
  return [...current, { id, slot }];
}
/** Geometry stays in the DOM during gestures so live iframes keep their connection. */
export function BlenderFloatingWindow({ title, status, index, onClose, children }: {
  title: string; status?: string; index: number; onClose: () => void; children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false), [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string>();
  // Same 22rem shell and 44px header as the original live/model preview window.
  const width = Math.min(352, Math.max(1, window.innerWidth - 32)), height = 44 + width * 9 / 16;
  const columns = Math.max(1, Math.floor((window.innerWidth - 16) / (width + 16)));
  const geometry = useRef({ x: Math.max(0, window.innerWidth - 16 - width - (index % columns) * (width + 16)),
    y: Math.max(0, window.innerHeight - 80 - height - Math.floor(index / columns) * (height + 16)), width, height });
  const gesture = useRef<{ kind: "move" | "resize"; x: number; y: number; origin: typeof geometry.current } | null>(null);
  const paint = () => {
    const node = host.current; if (!node) return;
    const g = geometry.current;
    Object.assign(node.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width}px`, height: `${g.height}px` });
  };
  const focus = () => { if (host.current) host.current.style.zIndex = String(++nextLayer); };
  useEffect(() => {
    focus();
    const changed = () => { setFullscreen(document.fullscreenElement === host.current); };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (maximized || fullscreen) Object.assign(host.current!.style, { left: "0px", top: "0px", width: "100vw", height: "100vh" });
    else paint();
  }, [maximized, fullscreen]);
  useEffect(() => {
    const cancel = () => { gesture.current = null; };
    const resize = () => {
      cancel(); if (maximized || fullscreen) return;
      const g = geometry.current;
      g.width = Math.min(g.width, window.innerWidth); g.height = Math.min(g.height, window.innerHeight);
      g.x = Math.max(0, Math.min(g.x, window.innerWidth - g.width)); g.y = Math.max(0, Math.min(g.y, window.innerHeight - g.height)); paint();
    };
    window.addEventListener("blur", cancel); window.addEventListener("resize", resize);
    return () => { window.removeEventListener("blur", cancel); window.removeEventListener("resize", resize); };
  }, [maximized, fullscreen]);
  function start(event: ReactPointerEvent<HTMLElement>, kind: "move" | "resize") {
    if (event.button !== 0 || maximized || fullscreen || (kind === "move" && (event.target as HTMLElement).closest("button"))) return;
    event.preventDefault(); focus();
    gesture.current = { kind, x: event.clientX, y: event.clientY, origin: { ...geometry.current } };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current; if (!g) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    if (g.kind === "move") geometry.current = { ...g.origin,
      x: Math.max(0, Math.min(window.innerWidth - 100, g.origin.x + dx)), y: Math.max(0, Math.min(window.innerHeight - 48, g.origin.y + dy)) };
    else geometry.current = { ...g.origin,
      width: Math.max(Math.min(320, window.innerWidth - g.origin.x), Math.min(window.innerWidth - g.origin.x, g.origin.width + dx)),
      height: Math.max(Math.min(240, window.innerHeight - g.origin.y), Math.min(window.innerHeight - g.origin.y, g.origin.height + dy)) };
    paint();
  }
  const end = () => { gesture.current = null; };
  return <Panel ref={host} role="dialog" aria-label={title} data-blender-window="" data-blender-frame=""
    className={`fixed flex flex-col overflow-hidden text-ink ${maximized || fullscreen ? "!rounded-none" : ""}`}
    onPointerDownCapture={focus}>
      <div className="relative flex h-11 shrink-0 touch-none cursor-grab items-center justify-center px-3 select-none active:cursor-grabbing"
        data-blender-titlebar="" onPointerDown={e => start(e, "move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onDoubleClick={e => { if (!(e.target as HTMLElement).closest("button") && !fullscreen) setMaximized(v => !v); }}>
        {status && <div className="pointer-events-none absolute top-3 left-3.5"><Badge>{status}</Badge></div>}
        <span className="pointer-events-none max-w-[45%] truncate text-sm font-medium text-ink-strong">{title}</span>
        <Button variant="ghost" size="sm" shape="square" icon={XIcon} aria-label="Close this Blender window" title="Close the view; background tasks keep running" onClick={onClose} className="absolute top-3 right-3.5" />
      </div>
      {error && <p role="alert" className="px-3 text-xs">{error}</p>}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
        <div className="absolute right-3.5 bottom-3 z-20 flex gap-1">
          <Button variant="ghost" size="sm" shape="square" icon={CornersOutIcon} aria-label={fullscreen ? "Exit Blender fullscreen" : "Blender fullscreen"}
            onClick={() => { setError(undefined); void (fullscreen ? document.exitFullscreen() : host.current!.requestFullscreen()).catch(() => setError("The browser did not enter fullscreen; use the expand button.")); }} />
          <Button variant="ghost" size="sm" shape="square" icon={maximized ? ArrowsInIcon : ArrowsOutIcon}
            aria-label={maximized ? "Restore Blender window" : "Maximize Blender window"} title={maximized ? "Restore small window" : "Expand to the whole workbench"}
            disabled={fullscreen} onClick={() => { focus(); setMaximized(v => !v); }} />
        </div>
        {!maximized && !fullscreen && <div role="separator" aria-label="Resize Blender window" className="absolute right-0 bottom-14 z-20 h-6 w-3 touch-none cursor-nwse-resize text-center text-xs text-ink-faint"
          onPointerDown={e => start(e, "resize")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}><span aria-hidden="true">⋮</span></div>}
      </div>
  </Panel>;
}
