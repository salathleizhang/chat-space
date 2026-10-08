import { ChatServiceError } from "../common/errors";
/** Standalone Bun uploads use base64; browser-local builds replace this decoder. */
export async function uploadedBytes(input: { dataBase64?: string; localPath?: string }): Promise<Uint8Array<ArrayBuffer>> {
  if (input.localPath) throw new ChatServiceError("浏览器本地文件不能由本机服务读取", 400, "local_upload_unavailable");
  return new Uint8Array(Buffer.from(input.dataBase64 ?? "", "base64"));
}
