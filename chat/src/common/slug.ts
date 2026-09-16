import { ChatServiceError } from "./errors";
import { SlugSchema } from "../dto/library";

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parsed = SlugSchema.safeParse(slug);
  if (!parsed.success) {
    throw new ChatServiceError(`无法从「${input}」生成合法 slug`, 400, "invalid_slug");
  }
  return parsed.data;
}

/** 宽松版：失败时退到带前缀的时间戳 slug，供自动命名场景使用 */
export function slugifyOrFallback(input: string, prefix = "item"): string {
  try {
    return slugify(input);
  } catch {
    return `${prefix}-${Date.now().toString(36)}`;
  }
}
