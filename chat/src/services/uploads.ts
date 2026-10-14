import { ChatServiceError } from "../common/errors";
/** Standalone Bun uploads use base64; browser-local builds replace this decoder. */
export async function uploadedBytes(input: { dataBase64?: string; localPath?: string }): Promise<Uint8Array<ArrayBuffer>> {
  if (input.localPath) throw new ChatServiceError("Browser-local files cannot be read by the local service", 400, "local_upload_unavailable");
  return new Uint8Array(Buffer.from(input.dataBase64 ?? "", "base64"));
}
