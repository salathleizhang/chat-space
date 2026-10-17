import { afterEach, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import JSZip from "jszip";

/**
 * 备份面板（设置对话框里那个）的接线测试，钉住四件事：
 *
 * 1. 说明与两个按钮都在**同一个面板**里——"数据只存在这个浏览器"和它的出口不能再分家；
 * 2. 点导出**真的接到了逻辑上**：`ensureBrowserLocal()` 失败必须显示在 `role="status"` 上。
 *    只断言"按钮存在"的话，把 onClick 摘掉测试照样绿——这正是要防的静默失效；
 * 3. **导入不再是"整包拒绝"**（2026-07-17 用户报的 "The backup conflicts with the current project"）：
 *    选包之后先给计划（冲突/缺失/多余各多少），此时一个字节都不写，再由用户选
 *    Merge / Overwrite / Replace。三种语义都要看到**真实写入**与**真实删除**。
 * 4. 选错文件（不是 zip、不是本应用的备份）只报原因，不碰工作区。
 *
 * happy-dom 没有 indexedDB，所以 `./storage` 与 `./client` 整体替换（`mock.module` 是全量替换，
 * 其余导出摊平保留）。面板与这两个模块之间只剩 `localEntries` / `commitLocal` /
 * `ensureBrowserLocal` 三个接触点，替换它们不影响本文件要验的接线。
 */
const actualStorage = await import("./storage");
const actualClient = await import("./client");

let existing: { path: string; value: string; updatedAt: number }[] = [];
const written: { path: string; value: unknown }[] = [];
const removed: string[] = [];
let ensureFailure: Error | undefined;

mock.module("./storage", () => ({
  ...actualStorage,
  localEntries: async (prefix = "") => existing.filter((entry) => entry.path.startsWith(prefix)),
  localEntry: async (path: string) => existing.find((entry) => entry.path === path),
  commitLocal: async (entries: { path: string; value: unknown }[], remove: string[] = []) => { written.push(...entries); removed.push(...remove); },
}));
mock.module("./client", () => ({
  ...actualClient,
  ensureBrowserLocal: async () => { if (ensureFailure) throw ensureFailure; },
}));

const { BackupPanel } = await import("./BackupPanel");

const PROJECT = JSON.stringify({ slug: "p-a", name: "大场景" });
const GLB = new Uint8Array([1, 2, 3, 4]);
const CONFLICT = "projects/p-a/project.json";
const EXTRA = "projects/p-old/project.json";

async function backupZip(): Promise<File> {
  const zip = new JSZip();
  zip.file(CONFLICT, PROJECT);
  zip.file("projects/p-a/assets/x.glb", GLB);
  zip.file(".jobs/task-1.json", JSON.stringify({ done: false }));
  zip.file("chatspace-backup.json", JSON.stringify({ version: 1, savedAt: "2026-10-17T00:00:00.000Z", files: 4 }));
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  return new File([blob], "chatspace-2026-10-16.zip", { type: "application/zip" });
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(BackupPanel)));
  return { container, root };
}

/** 面板的导入是"解析 → 校验 → 列现有文件"三段异步，等文本出现比数微任务稳。 */
async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
  throw new Error(`面板里始终没有出现「${text}」：${container.textContent?.slice(0, 200)}`);
}

async function choose(container: HTMLElement, file: File) {
  const input = container.querySelector("input[type=file]") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}

const button = (container: HTMLElement, label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const settle = async () => { for (let index = 0; index < 10; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
const unmount = async (rendered: { container: HTMLElement; root: ReturnType<typeof createRoot> }) => {
  await act(async () => rendered.root.unmount());
  rendered.container.remove();
};

afterEach(() => { existing = []; written.length = 0; removed.length = 0; ensureFailure = undefined; document.body.innerHTML = ""; });

test("备份面板渲染说明与两个按钮，点击导出把失败原因显示出来", async () => {
  const rendered = await render();
  try {
    expect(rendered.container.textContent).toContain("Data is stored in this browser");
    expect(rendered.container.textContent).toContain("Export backup");
    expect(rendered.container.textContent).toContain("Import backup");
    // 导入走隐藏的 file input，必须收 .zip
    expect(rendered.container.querySelector("input[type=file]")?.getAttribute("accept")).toBe(".zip");

    ensureFailure = new Error("The local build requires a modern browser that supports Service Worker, IndexedDB, and Web Locks");
    const exportButton = button(rendered.container, "Export backup");
    expect(exportButton?.disabled).toBe(false);
    await act(async () => { exportButton?.click(); await Promise.resolve(); });
    expect(rendered.container.querySelector("[role=status]")?.textContent ?? "").toContain("modern browser");
  } finally {
    await unmount(rendered);
  }
});

test("选包先给计划：冲突/缺失/多余各自报数，且此时一个字节都没写", async () => {
  existing = [
    { path: CONFLICT, value: "{}", updatedAt: 1 },
    { path: EXTRA, value: "{}", updatedAt: 1 },
  ];
  const rendered = await render();
  try {
    await choose(rendered.container, await backupZip());
    await waitForText(rendered.container, "3 files");
    expect(rendered.container.textContent).toContain("1 with the same path, 2 missing here, 1 only here");
    expect(rendered.container.textContent).toContain("Merge · add 2");
    expect(rendered.container.textContent).toContain("Overwrite the 1 matching");
    expect(rendered.container.textContent).toContain("Replace everything");
    expect(written).toHaveLength(0); // 只读阶段：给用户看清楚之前不许动工作区
    expect(removed).toHaveLength(0);
  } finally {
    await unmount(rendered);
  }
});

test("Merge 只写缺失：已有的同名文件与「只在这里」的文件都不动（旧实现在这里整包拒绝）", async () => {
  existing = [
    { path: CONFLICT, value: "{}", updatedAt: 1 },
    { path: EXTRA, value: "{}", updatedAt: 1 },
  ];
  const rendered = await render();
  try {
    await choose(rendered.container, await backupZip());
    await waitForText(rendered.container, "Merge · add 2");
    await act(async () => { button(rendered.container, "Merge · add 2")?.click(); });
    await settle();
    expect(written.map((entry) => entry.path).sort()).toEqual([".jobs/task-1.json", "projects/p-a/assets/x.glb"].sort());
    expect(removed).toEqual([]);
    // `.jobs` 必须落成字符串：应用里有 JSON.parse(entry.value as string) 的续跑路径
    expect(typeof written.find((entry) => entry.path === ".jobs/task-1.json")?.value).toBe("string");
    expect(written.find((entry) => entry.path === "projects/p-a/assets/x.glb")?.value).toBeInstanceOf(Blob);
  } finally {
    await unmount(rendered);
  }
});

test("Overwrite 写全部备份文件但不删本地的多余文件", async () => {
  existing = [
    { path: CONFLICT, value: "{}", updatedAt: 1 },
    { path: EXTRA, value: "{}", updatedAt: 1 },
  ];
  const rendered = await render();
  try {
    await choose(rendered.container, await backupZip());
    await waitForText(rendered.container, "Overwrite the 1 matching");
    await act(async () => { button(rendered.container, "Overwrite the 1 matching")?.click(); });
    await settle();
    expect(written.map((entry) => entry.path).sort()).toEqual([".jobs/task-1.json", CONFLICT, "projects/p-a/assets/x.glb"].sort());
    expect(removed).toEqual([]);
  } finally {
    await unmount(rendered);
  }
});

test("Replace 才删掉备份里没有的文件", async () => {
  existing = [
    { path: CONFLICT, value: "{}", updatedAt: 1 },
    { path: EXTRA, value: "{}", updatedAt: 1 },
  ];
  const rendered = await render();
  try {
    await choose(rendered.container, await backupZip());
    await waitForText(rendered.container, "Replace everything");
    await act(async () => { button(rendered.container, "Replace everything")?.click(); });
    await settle();
    expect(removed).toEqual([EXTRA]);
    expect(written).toHaveLength(3);
  } finally {
    await unmount(rendered);
  }
});

test("选错文件不当成备份：只显示原因，不写工作区", async () => {
  existing = [{ path: CONFLICT, value: "{}", updatedAt: 1 }];
  const rendered = await render();
  try {
    await choose(rendered.container, new File([new Uint8Array(256)], "not-a-backup.zip", { type: "application/zip" }));
    await waitForText(rendered.container, "not a zip file");
    expect(rendered.container.textContent).not.toContain("Merge · add");
    expect(written).toHaveLength(0);
  } finally {
    await unmount(rendered);
  }
});
