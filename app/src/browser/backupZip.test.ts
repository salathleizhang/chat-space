import { expect, test } from "bun:test";
import JSZip from "jszip";
import { backupErrorMessage, parseBackupZip, planBackupImport, readBackupManifest, readBackupValue } from "./backupZip";

/**
 * 这套用例守的是**导入侧的数据通路**，不是"函数返回了数组"：
 *
 * - 目录项与 `chatspace-backup.json` 不能进工作区（后者进了就会变成应用永远不会产生的杂散文件）；
 * - `.json` 必须落成**字符串**、二进制必须落成 **Blob 且字节相同**——应用里有
 *   `JSON.parse(entry.value as string)` 的读取路径（`.jobs/` 续跑），存成 Blob 会让任务轮询当场抛错；
 * - 计划要如实报告冲突/缺失/多余，因为"整包拒绝"就是被这条判据堵死的（2026-10-17 用户报的
 *   "The backup conflicts with the current project"）。
 *
 * 真值是**用 JSZip 现打的包**（不是手写字节），因为线上导出走的就是 JSZip。
 */

const PROJECT = JSON.stringify({ slug: "p-a", name: "大场景" });
const JOB = JSON.stringify({ done: false, nextAt: 0 });
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 255]);
const MANIFEST = JSON.stringify({ version: 1, savedAt: "2026-10-17T00:00:00.000Z", files: 4 });
const utf8 = (text: string) => new TextEncoder().encode(text).length;

async function fixture(compression: "STORE" | "DEFLATE", manifest: string = MANIFEST): Promise<Blob> {
  const zip = new JSZip();
  zip.file("projects/p-a/project.json", PROJECT);
  zip.file("projects/p-a/assets/x.glb", GLB);
  zip.file(".jobs/task-1.json", JOB);
  zip.folder("projects/p-b"); // 目录项：不该被当成文件
  zip.file("chatspace-backup.json", manifest);
  return zip.generateAsync({ type: "blob", compression });
}

test("中央目录解析：跳过目录项与清单，其余条目按名字与尺寸如实列出", async () => {
  const archive = await parseBackupZip(await fixture("STORE"));
  expect(archive.entries.map((entry) => entry.name)).toEqual([
    "projects/p-a/project.json",
    "projects/p-a/assets/x.glb",
    ".jobs/task-1.json",
  ]);
  expect(archive.manifest?.name).toBe("chatspace-backup.json");
  const project = archive.entries[0]!;
  expect(project.method).toBe(0); // STORE：导出的包固定这一档，也正因为如此才能零拷贝落库
  expect(project.uncompressedSize).toBe(utf8(PROJECT));
  expect(await readBackupManifest(archive)).toMatchObject({ version: 1, files: 4 });
});

test("取数：.json 是字符串（应用按 string 读），二进制是字节相同的 Blob", async () => {
  const archive = await parseBackupZip(await fixture("STORE"));
  const byName = new Map(archive.entries.map((entry) => [entry.name, entry]));
  const text = await readBackupValue(archive, byName.get("projects/p-a/project.json")!);
  expect(typeof text).toBe("string");
  expect(JSON.parse(text as string)).toEqual({ slug: "p-a", name: "大场景" });
  const job = await readBackupValue(archive, byName.get(".jobs/task-1.json")!);
  expect(typeof job).toBe("string"); // 这条要是退化成 Blob，`.jobs/` 的续跑会在 JSON.parse 上崩
  const binary = await readBackupValue(archive, byName.get("projects/p-a/assets/x.glb")!);
  expect(binary).toBeInstanceOf(Blob);
  expect([...new Uint8Array(await (binary as Blob).arrayBuffer())]).toEqual([...GLB]);
});

test("deflate 档也能读（第三方/手工包的入口；导出固定 STORE）", async () => {
  if (typeof DecompressionStream === "undefined") return; // 只有浏览器侧需要这条；测试环境缺能力时不假装验过
  const archive = await parseBackupZip(await fixture("DEFLATE"));
  expect(archive.entries[0]!.method).toBe(8);
  const text = await readBackupValue(archive, archive.entries.find((entry) => entry.name.endsWith("project.json"))!);
  expect(JSON.parse(text as string).name).toBe("大场景");
  const binary = await readBackupValue(archive, archive.entries.find((entry) => entry.name.endsWith("x.glb"))!);
  expect([...new Uint8Array(await (binary as Blob).arrayBuffer())]).toEqual([...GLB]);
});

test("计划：冲突/缺失/多余/体积各自如实报告（旧实现在这里整包拒绝）", async () => {
  const archive = await parseBackupZip(await fixture("STORE"));
  const plan = planBackupImport(archive.entries, ["projects/p-a/project.json", "projects/p-old/project.json"]);
  expect([...plan.conflicts]).toEqual(["projects/p-a/project.json"]);
  expect(plan.missing.sort()).toEqual([".jobs/task-1.json", "projects/p-a/assets/x.glb"]);
  expect(plan.extra).toEqual(["projects/p-old/project.json"]);
  expect(plan.existing).toBe(2);
  expect(plan.bytes).toBe(utf8(PROJECT) + utf8(JOB) + GLB.length);
  // 完全不重叠（全新浏览器）：没有冲突，全部缺失——Merge 就是最安全的那条
  const fresh = planBackupImport(archive.entries, []);
  expect(fresh.conflicts.size).toBe(0);
  expect(fresh.missing).toHaveLength(3);
});

test("选错文件/坏包/版本不对/ZIP64 都给出明确原因，而不是静默读错", async () => {
  const message = async (blob: Blob): Promise<string> => {
    try { await parseBackupZip(blob); return "no error"; } catch (error) { return (error as Error).message; }
  };
  expect(await message(new Blob([new Uint8Array(64)]))).toBe("That is not a zip file");
  expect(await message(new Blob([new Uint8Array(8)]))).toBe("That is not a zip file");
  const oldVersion = await parseBackupZip(await fixture("STORE", JSON.stringify({ version: 2, files: 4 })));
  expect(await readBackupManifest(oldVersion).then(() => "no error", (error: Error) => error.message)).toBe("This is not a ChatSpace project backup");
  const noManifest = await parseBackupZip(await new JSZip().generateAsync({ type: "blob", compression: "STORE" }));
  expect(await readBackupManifest(noManifest).then(() => "no error", (error: Error) => error.message)).toBe("This is not a ChatSpace project backup");

  // 伪造 ZIP64：EOCD 里条目数为 0xffff。真包到不了 4 GB，但别的工具打的包可能，
  // 这里要的是"明确拒绝"而不是按 32 位字段读出垃圾偏移。
  const zip64 = new Uint8Array(22);
  const view = new DataView(zip64.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(10, 0xffff, true);
  expect(await message(new Blob([zip64]))).toBe("ZIP64 backups are not supported");
});

test("错误文案：配额与已知失败给可行动的句子，未知错误原样透出", () => {
  expect(backupErrorMessage(new Error("Not enough local storage; export a project backup or free up space first"), "Import failed"))
    .toBe("Not enough storage in this browser; free some space and import again");
  expect(backupErrorMessage(new Error("ZIP64 backups are not supported"), "Import failed"))
    .toBe("This backup is ZIP64, which this app cannot read yet");
  expect(backupErrorMessage(new Error("That is not a zip file"), "Import failed")).toBe("That is not a zip file");
  expect(backupErrorMessage(new Error("boom"), "Import failed")).toBe("boom");
  expect(backupErrorMessage(new Error(""), "Import failed")).toBe("Import failed");
});
