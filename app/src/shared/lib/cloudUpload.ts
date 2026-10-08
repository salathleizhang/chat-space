import { fileToBase64 } from "./fileEncoding";
/** Browser-local imports keep original files on this device; standalone Bun uses JSON uploads. */
export async function fileUploadPayload(file: File): Promise<{ dataBase64?: string; localPath?: string }> {
  if (import.meta.env.VITE_BROWSER_LOCAL === "1") {
    const { stageLocalFile } = await import("../../browser/client"); return stageLocalFile(file);
  }
  return { dataBase64: await fileToBase64(file) };
}
export async function pngUploadPayload(base64: string) {
  if (import.meta.env.VITE_BROWSER_LOCAL !== "1") return { dataBase64: base64 };
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  return fileUploadPayload(new File([bytes], "inspection.png", { type: "image/png" }));
}
