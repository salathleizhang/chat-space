export const BLENDER_ALLOWED_TOOLS = [
  "get_addon_status",
  "get_scene_info",
  "get_object_info",
  "get_viewport_screenshot",
  "execute_blender_code",
  "bpy_api_lookup",
  "describe_node_type",
  "export_scene",
] as const;

export function wrapResult(
  tool: string,
  result: unknown,
): { text: string; json: unknown; isError: boolean } {
  const container = result as { content?: unknown; isError?: unknown } | null;
  const isError = container?.isError === true;
  const content = container?.content;
  if (!Array.isArray(content)) {
    return { text: "", json: null, isError };
  }
  const text = content
    .map((part) => {
      const entry = part as { type?: string; text?: string };
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean)
    .join("\n");

  if (!text) return { text: "", json: null, isError };
  try {
    return { text, json: JSON.parse(text), isError };
  } catch {
    // 社区版少数工具直接回人类可读文本，解析不了是正常的——原样交回。
    void tool;
    return { text, json: null, isError };
  }
}
