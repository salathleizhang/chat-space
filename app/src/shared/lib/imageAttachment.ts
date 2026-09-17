export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

const IMAGE_EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Browser clipboard images may have no extension, but the upload endpoint needs one. */
export function imageFilesFromClipboard(data: DataTransfer): File[] {
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file" && ACCEPTED_IMAGE_TYPES.includes(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const files = itemFiles.length > 0 ? itemFiles : Array.from(data.files);
  return files.flatMap((file) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return [];
    if (/\.(?:png|jpe?g|webp)$/i.test(file.name)) return [file];
    const extension = IMAGE_EXTENSION_BY_TYPE[file.type];
    return extension
      ? [new File([file], `pasted-image.${extension}`, {
          type: file.type,
          lastModified: file.lastModified,
        })]
      : [];
  });
}
