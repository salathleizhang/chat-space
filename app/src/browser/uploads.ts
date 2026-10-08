import { getAssetStorage } from "../../../chat/src/services/assetStorage";
export async function uploadedBytes(input: { dataBase64?: string; localPath?: string }): Promise<Uint8Array<ArrayBuffer>> {
  if (input.localPath) return new Uint8Array(await getAssetStorage().readBytes(input.localPath));
  return new Uint8Array(Buffer.from(input.dataBase64 ?? "", "base64"));
}
