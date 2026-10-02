import type { TransformMode } from "../../../widgets/Viewport/transformMode";

/**
 * Blender 式变换快捷键的**纯契约**：`G` 移动 / `R` 旋转 / `S` 缩放。
 * 与 three 侧 `widgets/Viewport/index.tsx:570-586` 的 `onKeyDown` 逐条对齐——
 * 那里有四道闸门，缺一条都会出问题：
 *
 * ① **正在输入框里打字时不抢键**（`input`/`textarea`/`select`/`contentEditable`）：
 *    右栏与 Agent 输入框都在这个页面上，抢键的后果是"打字打到一半模型开始转"。
 * ② **带 meta/ctrl/alt 时不管**（那是浏览器/系统的快捷键，比如 ⌘S 保存）。
 * ③ **没有选中东西时不管**（没有 gizmo 就没有要变换的对象）。
 * ④ **第一人称模式下不管**（那个模式的 WASD/键位属于漫游）。
 */

/** 键位表：小写键名 → 模式。 */
export const MODE_KEYS: Readonly<Record<string, TransformMode>> = { g: "translate", r: "rotate", s: "scale" };

/**
 * 只取我们关心的那几个字段。`target` 故意收成 `unknown`：真实 `KeyboardEvent.target` 是
 * `EventTarget`，没法结构上赋给"有 tagName 的对象"——在函数里运行时收窄即可。
 */
export interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: unknown;
}

/** 闸门 ①：焦点是不是在可编辑元素上。 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { isContentEditable?: boolean; tagName?: string };
  if (element.isContentEditable) return true;
  return /^(input|textarea|select)$/i.test(element.tagName ?? "");
}

/** 闸门 ③④：这一轮该不该响应快捷键。 */
export function shouldHandleModeKeys(options: { firstPerson: boolean; selectionCount: number }): boolean {
  return !options.firstPerson && options.selectionCount > 0;
}

/**
 * 事件 → 模式。返回 null 表示"这次按键不归我们管"（调用方**不要** `preventDefault`）。
 */
export function modeForKey(event: KeyEventLike): TransformMode | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  return MODE_KEYS[event.key.toLowerCase()] ?? null;
}

/** 世界/局部空间：three 侧是工具栏按钮（`transformSpace === "world"` 时显示地球图标），不是快捷键。 */
export function toggleSpace(space: "world" | "local"): "world" | "local" {
  return space === "world" ? "local" : "world";
}
