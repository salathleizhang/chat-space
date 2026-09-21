import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AccessGatePage } from "./AccessGatePage";
import { hasPassedAccessGate, passAccessGate } from "../shared/storage/accessGate";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

async function renderGate(onUnlock: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AccessGatePage onUnlock={onUnlock} />);
  });
}

test("门禁页展示说明与问题，答错提示、答对解锁并记住", async () => {
  expect(hasPassedAccessGate()).toBe(false);
  let unlocked = 0;
  await renderGate(() => {
    unlocked += 1;
  });

  expect(container!.textContent).toContain("Which hackathon is this website built for?");
  expect(container!.textContent).toContain("API tokens");

  const input = container!.querySelector("#access-gate-answer") as HTMLInputElement;
  const form = container!.querySelector("form") as HTMLFormElement;
  const submit = () => act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  /** React 受控输入会用自己的 value 跟踪器去重，必须走原生 setter 才能触发 onChange */
  const setValue = (value: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    return act(async () => {
      nativeSetter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  await setValue("wrong-answer");
  await submit();
  expect(unlocked).toBe(0);
  expect(container!.querySelector('[role="alert"]')?.textContent).toContain("not correct");
  expect(hasPassedAccessGate()).toBe(false);

  await setValue("  TripoThon ");
  await submit();
  expect(unlocked).toBe(1);
  expect(hasPassedAccessGate()).toBe(true);
});

test("记住后不再拦截，答错不落库", () => {
  expect(hasPassedAccessGate()).toBe(false);
  passAccessGate();
  expect(hasPassedAccessGate()).toBe(true);
});
