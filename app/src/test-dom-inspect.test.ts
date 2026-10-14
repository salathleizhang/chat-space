import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describeDomNode, domNodeInspectInstalled } from "./test-dom-inspect";

/**
 * 守 `test-dom-inspect.ts` 那个钩子：DOM 节点进断言失败输出时必须是**一行**，
 * 而不是整张带环的节点图（本机实测：不挂钩子时同一条断言吐 89.8 MB，
 * AgentDock 树上那条更狠——直接 SIGTRAP、退出码 133、一行输出都没有）。
 */

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const APP_ROOT = resolve(import.meta.dir, "..");

describe("describeDomNode", () => {
  test("元素：标签 + id + 前三个 class + 一行文字", () => {
    const element = document.createElement("div");
    element.id = "dock";
    element.className = "a b c d e";
    element.textContent = "  生成 \n  一把椅子  ";
    // 文字排在标签**后面**（`<div#app> "hello"`）：读起来就是"这个元素的正文是什么"
    expect(describeDomNode(element)).toBe('<div#dock.a.b.c> "生成 一把椅子"');
  });

  test("没有 id/class/文字时不留空壳", () => {
    expect(describeDomNode(document.createElement("span"))).toBe("<span>");
  });

  test("class 只取前三个（class 常常一长串，全打出来会淹掉标签）", () => {
    const element = document.createElement("div");
    element.className = "a b c d e";
    expect(describeDomNode(element)).toBe("<div.a.b.c>");
  });

  test("文本、注释、document、fragment 各有自己的写法", () => {
    expect(describeDomNode(document.createTextNode("hi"))).toBe('#text "hi"');
    expect(describeDomNode(document.createComment("x"))).toBe("#comment");
    expect(describeDomNode(document)).toBe("#document");
    // happy-dom 的 fragment.nodeName 是 "#"（规范是 "#document-fragment"），这里按 nodeType 认
    expect(describeDomNode(document.createDocumentFragment())).toBe("#document-fragment");
  });

  test("长文字截断：失败信息不该被正文淹没", () => {
    const element = document.createElement("p");
    element.textContent = "一".repeat(200);
    const described = describeDomNode(element);
    expect(described).toBe(`<p> "${"一".repeat(40)}…"`);
  });
});

test("preload 确实挂上了钩子，而且只改打印、不改比较语义", () => {
  expect(domNodeInspectInstalled()).toBe(true);

  const element = document.createElement("div");
  element.id = "dock";
  document.body.appendChild(element);
  try {
    const hook = (element as unknown as Record<symbol, ((this: Node) => string) | undefined>)[INSPECT];
    expect(typeof hook).toBe("function");
    expect(hook?.call(element)).toBe("<div#dock>");

    // 身份比较 / 查找 / 包含关系都不受影响——钩子只作用于"格式化"这一步
    expect(document.querySelector("#dock")).toBe(element);
    expect(element.parentElement).toBe(document.body);
    expect(element.contains(element)).toBe(true);
  } finally {
    element.remove();
  }
});

test(
  "夹具断言失败时只打印一行节点描述，不是整张 DOM 图",
  () => {
    const fixture = resolve(import.meta.dir, "test-dom-diff.fixture.test.tsx");
    const run = spawnSync(process.execPath, ["test", fixture], {
      cwd: APP_ROOT,
      env: { ...process.env, CHATSPACE_DOM_DIFF_FIXTURE: "1" },
      encoding: "utf8",
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;

    // 1 = 断言失败（夹具本来就该失败）；被信号打死时 status 是 null
    expect({ status: run.status, signal: run.signal }).toEqual({ status: 1, signal: null });
    // 不挂钩子时的**负对照**（本机实测）：直接重定向到文件是 89.8 MB，经子进程管道读回是 635 KB
    // —— 不管哪条都远大于这里的阈值，所以"输出小"本身就是判据
    expect(output.length).toBeLessThan(8_000);
    expect(output).toContain("Expected:");
    expect(output).toContain("<div#app>");
    expect(output).toContain("<button#portal-btn>");
  },
  // 子进程要起一次 bun；默认 5 s 在忙机上不够（AGENTS.md 记过过载机器把 check 顶到 2909 s）
  60_000,
);
