import { afterEach, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BlenderFloatingWindow, openBlenderWindow } from "./FloatingWindow";

const mounted: { root: Root; container: HTMLElement }[] = [];
afterEach(async () => { for (const { root, container } of mounted.splice(0)) { await act(async () => root.unmount()); container.remove(); } });
async function render() {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  function Windows() {
    const [ids, setIds] = useState(["A", "B"]);
    return ids.map((id, index) => <BlenderFloatingWindow key={id} title={`Blender ${id}`} index={index}
      onClose={() => setIds(current => current.filter(value => value !== id))}><iframe title={id} src={`about:blank#${id}`} /></BlenderFloatingWindow>);
  }
  await act(async () => root.render(<Windows />));
  return container;
}
async function click(node: Element) { await act(async () => (node as HTMLElement).click()); }
function pointer(node: Element, type: string, x: number, y: number) {
  node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
}

test("two desktops stay mounted independently when one window closes", async () => {
  const container = await render(); const b = container.querySelector('iframe[title="B"]');
  expect(container.querySelectorAll("iframe").length).toBe(2);
  await click(container.querySelector('[aria-label="Blender A"] [aria-label="Close this Blender window"]')!);
  expect(container.querySelector('iframe[title="A"]')).toBeNull(); expect(container.querySelector('iframe[title="B"]')).toBe(b);
});

test("initial windows keep the original small preview size and appear side by side", async () => {
  const container = await render(); const frames = [...container.querySelectorAll<HTMLElement>("[data-blender-window]")];
  expect(frames[0]!.style.width).toBe("352px"); expect(frames[0]!.style.height).toBe("242px");
  expect(parseFloat(frames[0]!.style.left) - parseFloat(frames[1]!.style.left)).toBe(368);
  expect(frames[0]!.style.top).toBe(frames[1]!.style.top);
});

test("closing and reopening a window reuses its vacancy without colliding with the remaining window", () => {
  const original = openBlenderWindow(openBlenderWindow([], "A"), "B");
  const remaining = original.filter(window => window.id !== "A");
  const reopened = openBlenderWindow(remaining, "A");
  expect(reopened.find(window => window.id === "B")).toBe(remaining[0]!);
  expect(new Set(reopened.map(window => window.slot)).size).toBe(2);
  expect(reopened.find(window => window.id === "A")!.slot).toBe(original[0]!.slot);
  expect(openBlenderWindow(reopened, "B")).toBe(reopened);
});

test("maximizing fills the viewport and restores geometry without replacing the desktop", async () => {
  const container = await render(); const frame = container.querySelector('[aria-label="Blender A"]') as HTMLElement;
  const iframe = frame.querySelector("iframe"), before = { width: frame.style.width, height: frame.style.height, left: frame.style.left };
  await click(frame.querySelector('[aria-label="Maximize Blender window"]')!);
  expect(frame.style.width).toBe("100vw"); expect(frame.style.height).toBe("100vh"); expect(frame.style.left).toBe("0px");
  expect(frame.querySelector("iframe")).toBe(iframe);
  await click(frame.querySelector('[aria-label="Restore Blender window"]')!);
  expect(frame.style.width).toBe(before.width); expect(frame.style.height).toBe(before.height); expect(frame.style.left).toBe(before.left);
  expect(frame.querySelector("iframe")).toBe(iframe);
});

test("drag and resize preserve both iframe nodes; blur cancels the gesture", async () => {
  const container = await render(); const frame = container.querySelector('[aria-label="Blender A"]') as HTMLElement;
  const iframes = [...container.querySelectorAll("iframe")];
  const before = { left: parseFloat(frame.style.left), top: parseFloat(frame.style.top) };
  const header = frame.querySelector("[data-blender-titlebar]") as HTMLElement; header.setPointerCapture = mock(() => {});
  await act(async () => { pointer(header, "pointerdown", 100, 100); pointer(header, "pointermove", 130, 120); });
  expect(parseFloat(frame.style.left)).toBe(Math.min(window.innerWidth - 100, before.left + 30)); expect(parseFloat(frame.style.top)).toBe(Math.min(window.innerHeight - 48, before.top + 20));
  window.dispatchEvent(new Event("blur"));
  await act(async () => pointer(header, "pointermove", 180, 180)); expect(parseFloat(frame.style.left)).toBe(Math.min(window.innerWidth - 100, before.left + 30));
  const resize = frame.querySelector('[aria-label="Resize Blender window"]') as HTMLElement; resize.setPointerCapture = mock(() => {});
  const width = parseFloat(frame.style.width);
  await act(async () => { pointer(resize, "pointerdown", 400, 300); pointer(resize, "pointermove", 340, 250); pointer(resize, "pointerup", 340, 250); });
  expect(parseFloat(frame.style.width)).toBe(Math.max(320, width - 60));
  expect([...container.querySelectorAll("iframe")]).toEqual(iframes);
});

test("pressing a window control cannot start a drag", async () => {
  const container = await render(); const frame = container.querySelector('[aria-label="Blender A"]') as HTMLElement;
  const before = frame.style.left, header = frame.querySelector("[data-blender-titlebar]") as HTMLElement;
  header.setPointerCapture = mock(() => {});
  await act(async () => { pointer(frame.querySelector("button")!, "pointerdown", 100, 100); pointer(header, "pointermove", 150, 150); });
  expect(frame.style.left).toBe(before); expect(header.setPointerCapture).toHaveBeenCalledTimes(0);
});
