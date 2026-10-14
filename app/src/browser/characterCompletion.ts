import { LogicalPathSchema, RequestSidecarSchema } from "../../../chat/src/dto/library";
import { readJson, type AssetStorage } from "../../../chat/src/services/assetStorage";
import { publishGeneratedModel } from "../../../chat/src/services/modelPublishing";

/** 轮询分段执行绕过了 runTripoCharacter 的函数尾部，必须在结算前补上正式资产发布。 */
export async function publishCompletedCharacter(
  storage: AssetStorage, projectSlug: string, assetSlug: string,
  receiptPaths: string[], result: unknown,
): Promise<void> {
  const receipts = await Promise.all(receiptPaths.map(path => readJson(storage, path, RequestSidecarSchema)));
  const generation = receipts.find(receipt => receipt.model === "v3/generation/image-to-model" && receipt.status === "succeeded");
  const rig = receipts.find(receipt => receipt.model === "/animations/rig" && receipt.status === "succeeded");
  if (!generation || !rig) throw new Error("Character generation and rigging must both finish before publishing");
  const image = LogicalPathSchema.parse(generation.params.image);
  await publishGeneratedModel(storage, projectSlug, {
    slug: assetSlug, name: assetSlug, intent: `Rigged 3D character of ${assetSlug}`, sourceImages: [image],
  }, result);
}
