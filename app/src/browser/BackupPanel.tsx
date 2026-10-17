import { useEffect, useRef, useState } from "react";
import { Button } from "../shared/ui";
import { commitLocal, localEntries, type LocalEntry } from "./storage";
import { ensureBrowserLocal } from "./client";
import { backupErrorMessage, parseBackupZip, planBackupImport, readBackupManifest, readBackupValue, type BackupArchive, type BackupPlan } from "./backupZip";

/**
 * 浏览器本地版的**唯一逃生口**，放在设置对话框里。
 *
 * 这个构建（`VITE_BROWSER_LOCAL=1`）的项目、会话、文件全在 IndexedDB 里，站点服务端
 * 只有供应商代理（`api/server.ts` → `proxyFetch`），**不存任何用户数据**：
 * 清除站点数据、换设备、换域名（预览 URL → 正式域名是不同 origin）都会让数据不可见，
 * 所以"导出/导入"不是可选功能，而是唯一的找回路径。
 *
 * 四条已知边界（改这里之前先读）：
 * - 备份**不含** localStorage 里的偏好（模型预设、语音语言、门禁）；供应商密钥也不在里面
 *   （密钥早已迁到服务端），所以 zip 里没有秘密，但"新设备导入"之后模型要重设。
 * - **导入不再要求空工作区**（2026-10-17）。旧口径是"任何一个路径撞上就整包拒绝"，实测把唯一
 *   的找回路径堵死：应用没有删除项目/清空本地数据的入口，而 `.jobs/`、`sessions/` 的残留
 *   没法从界面清掉，于是**同一个域名一旦用过，备份就永远进不来**（用户报的
 *   "The backup conflicts with the current project"）。现在选包之后先给计划，再让用户在
 *   Merge / Overwrite / Replace 之间选。三种语义见 `apply()`。
 * - 导入走**流式**（`backupZip.ts`），不是 JSZip：旧实现是 `loadAsync()` 全内存 + 一次性事务，
 *   2026-10-17 实测 454 MB 的包**63 分钟写 0 个文件**（不报错、不崩），流式 1.0 s 写完。
 * - 导出仍是 `localEntries()` + JSZip 全内存打包。真实工作区量级（本机一份项目 2.1 GB / 935 个文件、
 *   单个 GLB 40 MB+）会顶不住；这里没有做成流式，别把它当成能撑大工作区的备份。
 */

/** 每个事务写多少个文件。小批量既能让进度条动起来，也让配额不足时不会一次性丢光进度。 */
const BATCH_SIZE = 25;

type Pending = { archive: BackupArchive; plan: BackupPlan };
type ImportMode = "merge" | "overwrite" | "replace";

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export function BackupPanel() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<Pending | undefined>(undefined);
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
    } catch (error) { setMessage(backupErrorMessage(error, "Backup failed")); }
    finally { setBusy(false); }
  }
  /**
   * 选包之后**只读**：解析中央目录（几十 KB）+ 校验清单（几十字节）+ 与现有路径比对，
   * 不动工作区一个字节。用户看到"会改哪些文件"再决定，这是"整包拒绝"换成"给选择"的关键一步。
   */
  async function inspect(file?: File) {
    if (!file) return;
    setBusy(true); setMessage(""); setPending(undefined);
    try {
      await ensureBrowserLocal();
      const archive = await parseBackupZip(file);
      await readBackupManifest(archive);
      const existing = (await localEntries()).map(entry => entry.path);
      setPending({ archive, plan: planBackupImport(archive.entries, existing) });
    } catch (error) { setMessage(backupErrorMessage(error, "Import failed")); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  /**
   * 三种语义，区别只在"动哪些文件"：
   * - `merge`：只写工作区**没有**的路径。已有同名文件（可能是比备份更新的手工改动）一律不碰。
   * - `overwrite`：写备份里的**全部**路径，同名的用备份内容盖掉；备份里没有的文件保留。
   * - `replace`：先删掉工作区里"备份里没有"的文件，再写全部——等于还原成备份那一份快照。
   */
  async function apply(mode: ImportMode) {
    if (!pending) return;
    setBusy(true); setMessage("");
    const { archive, plan } = pending;
    const targets = mode === "merge" ? archive.entries.filter(entry => !plan.conflicts.has(entry.name)) : archive.entries;
    let done = 0;
    try {
      await ensureBrowserLocal();
      if (mode === "replace" && plan.extra.length) await commitLocal([], plan.extra);
      for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
        const batch: LocalEntry[] = [];
        for (const entry of targets.slice(offset, offset + BATCH_SIZE)) {
          batch.push({ path: entry.name, value: await readBackupValue(archive, entry), updatedAt: Date.now() });
        }
        await commitLocal(batch);
        done += batch.length;
        setMessage(`Importing ${done}/${targets.length}…`);
      }
      setMessage(`Imported ${done} files; reloading…`);
      location.reload();
    } catch (error) {
      // 中途失败（最常见是配额）要如实报进度，并告诉用户 merge 可以接着补——它天然可续。
      const tail = done ? ` ${done}/${targets.length} files were written; import again and choose Merge to continue.` : "";
      setMessage(`${backupErrorMessage(error, "Import failed")}${tail}`);
      setPending(undefined);
    }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-ink">Data is stored in this browser</span>
      <span className="text-xs text-ink-subtle">
        Projects, chats, and files live only in this browser: they do not sync after you switch devices, change the URL,
        or clear site data. Export a backup to keep them. Importing never deletes anything unless you pick Replace.
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void backup()}>{busy ? "Working…" : "Export backup"}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>Import backup</Button>
      </div>
      <input ref={input} className="hidden" type="file" accept=".zip" onChange={event => void inspect(event.target.files?.[0])} />
      {pending && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <span className="text-xs text-ink">
            Backup: {pending.archive.entries.length} files · {megabytes(pending.plan.bytes)} — this browser has {pending.plan.existing} files
            {" "}({pending.plan.conflicts.size} with the same path, {pending.plan.missing.length} missing here, {pending.plan.extra.length} only here).
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={busy || pending.plan.missing.length === 0} onClick={() => void apply("merge")}>
              Merge · add {pending.plan.missing.length}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void apply("overwrite")}>
              Overwrite the {pending.plan.conflicts.size} matching
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void apply("replace")}>
              Replace everything
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setPending(undefined); setMessage(""); }}>Cancel</Button>
          </div>
          <span className="text-xs text-ink-faint">
            Merge keeps every file that is already here (recommended when this browser has newer work). Replace deletes
            the {pending.plan.extra.length} files that are not in this backup.
          </span>
        </div>
      )}
      {message && <p role="status" className="text-xs text-ink-subtle">{message}</p>}
    </div>
  );
}
