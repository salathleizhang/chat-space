/**
 * OpenSCAD 编译 worker：WASM 的 callMain 是同步阻塞调用，放独立线程
 * 以免长编译卡死 chat/ 事件循环；超时由 cadOps 侧 terminate 兜底。
 * 每次编译起新实例——WASM 文件系统不跨请求复用，天然无状态。
 */
import createOpenSCAD from "../../vendor/openscad-wasm/openscad.js";

declare var self: Worker;

export interface CadWorkerRequest {
  scadCode: string;
}

export type CadWorkerResponse =
  | { ok: true; stl: Uint8Array; log: string[] }
  | { ok: false; error: string; log: string[] };

self.onmessage = async (event: MessageEvent<CadWorkerRequest>) => {
  const log: string[] = [];
  const reply = (response: CadWorkerResponse, transfer: ArrayBuffer[] = []) =>
    postMessage(response, transfer);
  try {
    const instance = await createOpenSCAD({
      noInitialRun: true,
      print: (line) => log.push(line),
      printErr: (line) => log.push(line),
    });
    instance.FS.writeFile("/input.scad", event.data.scadCode);
    const exitCode = instance.callMain([
      "/input.scad",
      "-o",
      "/out.stl",
      "--export-format",
      "binstl",
    ]);
    if (exitCode !== 0) {
      reply({ ok: false, error: `OpenSCAD 退出码 ${exitCode}`, log });
      return;
    }
    const stl = instance.FS.readFile("/out.stl");
    reply({ ok: true, stl, log }, [stl.buffer as ArrayBuffer]);
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err), log });
  }
};
