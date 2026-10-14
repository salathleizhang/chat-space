import { useEffect, useRef, useState } from "react";
import { commitLocal, localEntries } from "./storage";
import { ensureBrowserLocal } from "./client";

export function LocalStorageNotice() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const downloadUrl = useRef<string | undefined>(undefined);
  useEffect(() => () => { if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); }, []);
  async function backup() {
    setBusy(true); setMessage("");
    try {
      await ensureBrowserLocal();
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const files = await localEntries();
      for (const file of files) if (!file.path.startsWith(".uploads/") && !file.path.startsWith(".downloads/")) zip.file(file.path, file.value);
      zip.file("chatspace-backup.json", JSON.stringify({ version: 1, savedAt: new Date().toISOString(), files: files.length }));
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      const url = URL.createObjectURL(blob); downloadUrl.current = url;
      const link = document.createElement("a"); link.href = url; link.download = `chatspace-${new Date().toISOString().slice(0, 10)}.zip`; link.click();
      // Retain it until the next backup/unmount; starting a download is asynchronous.
      setMessage("Backup exported");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Backup failed"); }
    finally { setBusy(false); }
  }
  async function restore(file?: File) {
    if (!file) return;
    setBusy(true); setMessage("");
    try {
      await ensureBrowserLocal();
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(file);
      const manifest = zip.file("chatspace-backup.json");
      if (!manifest || JSON.parse(await manifest.async("string")).version !== 1) throw new Error("This is not a ChatSpace project backup");
      const existing = new Set((await localEntries()).map(entry => entry.path));
      const entries = await Promise.all(Object.values(zip.files).filter(entry => !entry.dir && entry.name !== "chatspace-backup.json").map(async entry => {
        if (existing.has(entry.name)) throw new Error("The backup conflicts with the current project; import it in another browser or an empty workspace");
        return { path: entry.name, value: entry.name.endsWith(".json") ? await entry.async("string") : await entry.async("blob"), updatedAt: Date.now() };
      }));
      await commitLocal(entries); location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Import failed"); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  return <div className="fixed bottom-3 left-3 z-50 rounded-lg border border-border bg-panel/95 px-3 py-2 text-xs text-ink shadow-sm">
    <span title="Projects, chats, and files are stored only in this browser. They will not sync automatically after you switch devices, change the URL, or clear site data; export a backup.">Data is stored in this browser</span>
    <button type="button" className="ml-3 underline" disabled={busy} onClick={() => void backup()}>{busy ? "Working…" : "Export backup"}</button>
    <button type="button" className="ml-3 underline" disabled={busy} onClick={() => input.current?.click()}>Import backup</button>
    <input ref={input} className="hidden" type="file" accept=".zip" onChange={event => void restore(event.target.files?.[0])} />
    {message && <p role="status" className="mt-1 max-w-xs">{message}</p>}
  </div>;
}
