export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

const IMAGE_EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Browser clipboard images may have no extension, but the upload endpoint needs one. */
export function imageFileFromClipboard(data: DataTransfer): File | null {
  const imageItem = Array.from(data.items).find(
    (item) => item.kind === "file" && ACCEPTED_IMAGE_TYPES.includes(item.type),
  );
  const file =
    imageItem?.getAsFile() ??
    Array.from(data.files).find((candidate) => ACCEPTED_IMAGE_TYPES.includes(candidate.type));
  if (!file) return null;
  if (/\.(?:png|jpe?g|webp)$/i.test(file.name)) return file;

  const mimeType = file.type || imageItem?.type || "";
  const extension = IMAGE_EXTENSION_BY_TYPE[mimeType];
  if (!extension) return null;
  return new File([file], `pasted-image.${extension}`, {
    type: mimeType,
    lastModified: file.lastModified,
  });
}
