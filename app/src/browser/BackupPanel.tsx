import { useEffect, useRef, useState } from "react";
import { Button } from "../shared/ui";
import { commitLocal, localEntries } from "./storage";
import { ensureBrowserLocal } from "./client";

/**
 * 浏览器本地版的**唯一逃生口**，放在设置对话框里。
 *
 * 这个构建（`VITE_BROWSER_LOCAL=1`）的项目、会话、文件全在 IndexedDB 里，站点服务端
 * 只有供应商代理（`api/server.ts` → `proxyFetch`），**不存任何用户数据**：
 * 清除站点数据、换设备、换域名（预览 URL → 正式域名是不同 origin）都会让数据不可见，
 * 所以"导出/导入"不是可选功能，而是唯一的找回路径。
 *
 * 三条已知边界（改这里之前先读）：
 * - 备份**不含** localStorage 里的偏好（模型预设、语音语言、门禁）；供应商密钥也不在里面
 *   （密钥早已迁到服务端），所以 zip 里没有秘密，但"新设备导入"之后模型要重设。
 * - 导入要求工作区为空：任何一个路径撞上就整包拒绝（不覆盖），见下面的 `existing` 判据。
 * - 导出是 `getAll()` + JSZip 全内存打包。真实工作区量级（本机一份项目 2.1 GB / 935 个文件、
 *   单个 GLB 40 MB+）会顶不住；这里没有做成流式，别把它当成能撑大工作区的备份。
 */
export function BackupPanel() {
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
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-ink">Data is stored in this browser</span>
      <span className="text-xs text-ink-subtle">
        Projects, chats, and files live only in this browser: they do not sync after you switch devices, change the URL,
        or clear site data. Export a backup to keep them; importing needs an empty workspace.
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void backup()}>{busy ? "Working…" : "Export backup"}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>Import backup</Button>
      </div>
      <input ref={input} className="hidden" type="file" accept=".zip" onChange={event => void restore(event.target.files?.[0])} />
      {message && <p role="status" className="text-xs text-ink-subtle">{message}</p>}
    </div>
  );
}
