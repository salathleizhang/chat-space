/**
 * **故意失败**的夹具：让 bun 去格式化两个 DOM 节点。
 *
 * 它只由 `test-dom-inspect.test.ts` 起子进程、带着 `CHATSPACE_DOM_DIFF_FIXTURE=1` 跑；
 * 平时 `bun test` 收集到它时是 **skip**——它必须失败才有意义，不能挂在正常套件里。
 *
 * 为什么值得单独留一条：钩子没挂上时，这一条要么吐几十 MB 的节点图，要么让整个进程
 * SIGTRAP（退出码 133、一行输出都没有）。见 `test-dom-inspect.ts` 的实测记录。
 */
import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

const guarded = process.env.CHATSPACE_DOM_DIFF_FIXTURE ? test : test.skip;

guarded("两条不同的 DOM 节点断言（bun 会把整张图打进 diff）", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(
      createElement(
        "div",
        { id: "app" },
        createElement("span", { id: "label" }, "hello"),
        createPortal(createElement("button", { id: "portal-btn" }, "x"), document.body),
      ),
    );
  });
  expect(container.querySelector("#app")).toBe(document.querySelector("#portal-btn"));
});
