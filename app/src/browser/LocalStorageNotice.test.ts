import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { dockStorageSlotRef } from "../shared/ui/dockRow";
import { LocalStorageNotice } from "./LocalStorageNotice";

test("备份入口在主页独立显示，在工作台进入自己的行，卸载槽位后恢复", async () => {
  const container = document.createElement("div");
  const dock = document.createElement("div");
  document.body.append(container, dock);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(LocalStorageNotice)));
    expect(container.textContent).toContain("Export backup");
    await act(async () => dockStorageSlotRef(dock));
    expect(container.textContent).toBe("");
    expect(dock.textContent).toContain("Import backup");
    expect(dock.querySelector("div")?.className.includes("fixed")).toBe(false);
    await act(async () => dockStorageSlotRef(null));
    expect(container.textContent).toContain("Export backup");
    expect(dock.textContent).toBe("");
  } finally {
    await act(async () => { dockStorageSlotRef(null); root.unmount(); });
    container.remove(); dock.remove();
  }
});
