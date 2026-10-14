/**
 * happy-dom 的 DOM 节点在 bun 的断言失败输出里会**整张图**被打印出来。
 *
 * 2026-10-04 本机实测：AgentDock 树上一条写错的 `expect(mic.parentElement).toBe(send.parentElement)`
 * 让 `bun test` 以 **SIGTRAP（退出码 133）**结束，**56 字节输出、一行错误都没有**——
 * 断言失败要先格式化 DOM 节点，而 React 之后的节点图带着 fiber、portal、document 之间的环，
 * 序列化它要么吐出 **37 MB**（另一个只有 React 小树、exit 1 的复现），要么直接把进程打崩。
 * 崩掉的那种最坑：看起来像"测试没跑"，实际上是一条断言错了。
 *
 * 修法：给 `Node.prototype` 挂一个 `nodejs.util.inspect.custom`——bun 的断言格式化认它。
 * 同一份复现在挂了之后是 **728 字节**的正常失败（`Expected: <SPAN> / Received: <DIV>`）。
 * 注意别的路子都**不**管用（实测）：`toJSON`、`Bun.inspect.custom`、`Symbol.toStringTag`
 * 三个都照旧吐 37 MB。
 *
 * 这**只改打印，不改比较**：`toBe` / `toEqual` 的语义、节点身份一律不动。
 */

/** 文本塌成一行并截断：DOM 里的文本常常带缩进换行，原样打出来就没法看了。 */
function collapse(text: string, limit = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * 一个节点 → 一行能定位的描述。挑的都是"断言失败时你真的想知道"的东西：
 * 标签、id、前几个 class、开头一段文字。纯函数， behavioural 单测直接打它。
 */
export function describeDomNode(node: Node): string {
  const name = node.nodeName.toLowerCase();
  if (node.nodeType === 1 /* ELEMENT_NODE */) {
    const element = node as Element;
    const id = element.id ? `#${element.id}` : "";
    const classes = element.classList.length
      ? `.${Array.from(element.classList).slice(0, 3).join(".")}`
      : "";
    const text = collapse(element.textContent ?? "");
    return `<${name}${id}${classes}>${text ? ` "${text}"` : ""}`;
  }
  if (node.nodeType === 3 /* TEXT_NODE */) return `#text "${collapse(node.textContent ?? "")}"`;
  if (node.nodeType === 8 /* COMMENT_NODE */) return "#comment";
  // 其余节点各有各的名字：happy-dom 的 DocumentFragment 的 nodeName 是 "#"（规范是
  // "#document-fragment"），所以这里按 nodeType 认，不跟着 nodeName 走。
  if (node.nodeType === 9 /* DOCUMENT_NODE */) return "#document";
  if (node.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */) return "#document-fragment";
  if (node.nodeType === 10 /* DOCUMENT_TYPE_NODE */) return "!doctype";
  return `#${name.replace(/^#/, "")}`;
}

/**
 * 挂上 inspect 钩子。在 `test-setup.ts`（bun test 的 preload）里调一次，
 * 所有测试文件就都受保护——这个坑不分文件，谁写错谁崩。
 */
export function installDomNodeInspect(): void {
  Object.defineProperty(Node.prototype, INSPECT, {
    configurable: true,
    writable: true,
    // 非枚举：happy-dom 自己会遍历节点属性，钩子不能变成它们的"自有属性"
    enumerable: false,
    value(this: Node) {
      return describeDomNode(this);
    },
  });
}

/** 有没有挂上（给回归测试用；也方便排查"钩子被谁覆盖了"）。 */
export function domNodeInspectInstalled(): boolean {
  return typeof (Node.prototype as unknown as Record<symbol, unknown>)[INSPECT] === "function";
}
