const FILE_URL_RE = /\.(glb|gltf|fbx|obj|usdz|blend|stl|3mf|png|jpe?g|webp)(\?|$)/i;

export interface FileUrlRef {
  url: string;
  /** 来源键路径（如 output.model / result.animation_url），用于诊断和命名。 */
  key: string;
}

/** 递归提取供应商任务结果里的文件 URL。 */
export function extractFileUrls(
  value: unknown,
  prefix = "",
  found: FileUrlRef[] = [],
): FileUrlRef[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => extractFileUrls(item, `${prefix}${index}.`, found));
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      extractFileUrls(nested, `${prefix}${key}.`, found);
    }
  } else if (
    typeof value === "string" &&
    /^https?:\/\//.test(value) &&
    FILE_URL_RE.test(value)
  ) {
    found.push({ url: value, key: prefix.replace(/\.$/, "") });
  }
  return found;
}
