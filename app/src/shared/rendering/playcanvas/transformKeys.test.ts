import { describe, expect, test } from "bun:test";
import { isTypingTarget, MODE_KEYS, modeForKey, shouldHandleModeKeys, toggleSpace } from "./transformKeys";

describe("G/R/S 快捷键契约（与 three 侧 index.tsx:570-586 逐条对齐）", () => {
  test("g/r/s（含大写）→ 三种模式；其它键不归我们管", () => {
    expect(modeForKey({ key: "g" })).toBe("translate");
    expect(modeForKey({ key: "r" })).toBe("rotate");
    expect(modeForKey({ key: "s" })).toBe("scale");
    expect(modeForKey({ key: "G" })).toBe("translate");
    expect(modeForKey({ key: "R" })).toBe("rotate");
    expect(modeForKey({ key: "S" })).toBe("scale");
    expect(modeForKey({ key: "q" })).toBeNull();
    expect(modeForKey({ key: "Escape" })).toBeNull();
    expect(modeForKey({ key: "Shift" })).toBeNull();
    expect(MODE_KEYS).toEqual({ g: "translate", r: "rotate", s: "scale" });
  });

  test("闸门①：输入框里打字不抢键（input/textarea/select/contentEditable）", () => {
    for (const tagName of ["input", "INPUT", "textarea", "select"]) {
      expect(modeForKey({ key: "g", target: { tagName } })).toBeNull();
    }
    expect(modeForKey({ key: "g", target: { tagName: "div", isContentEditable: true } })).toBeNull();
    // 普通元素/没有 target 时照常
    expect(modeForKey({ key: "g", target: { tagName: "div" } })).toBe("translate");
    expect(modeForKey({ key: "g", target: null })).toBe("translate");
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: "button" })).toBe(false);
  });

  test("闸门②：带 meta/ctrl/alt 一律不管（那是系统/浏览器快捷键）", () => {
    expect(modeForKey({ key: "g", metaKey: true })).toBeNull();
    expect(modeForKey({ key: "g", ctrlKey: true })).toBeNull();
    expect(modeForKey({ key: "g", altKey: true })).toBeNull();
  });

  test("闸门③④：没有选中 / 第一人称模式下不管", () => {
    expect(shouldHandleModeKeys({ firstPerson: false, selectionCount: 0 })).toBe(false);
    expect(shouldHandleModeKeys({ firstPerson: false, selectionCount: 1 })).toBe(true);
    expect(shouldHandleModeKeys({ firstPerson: false, selectionCount: 3 })).toBe(true);
    expect(shouldHandleModeKeys({ firstPerson: true, selectionCount: 2 })).toBe(false);
  });

  test("世界/局部是**切换**（three 侧是工具栏按钮，不是快捷键）", () => {
    expect(toggleSpace("world")).toBe("local");
    expect(toggleSpace("local")).toBe("world");
  });
});
