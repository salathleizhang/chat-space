import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { HomePage } from "./HomePage";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  globalThis.fetch = originalFetch;
});

test("首页选择多张图片后可直接创建项目，并把全部附件交给工作台", async () => {
  let createdName: string | undefined;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    createdName = JSON.parse(String(init?.body)).name as string;
    return Response.json({ project: { slug: "p-from-image", name: createdName } }, { status: 201 });
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:preview";
  URL.revokeObjectURL = () => {};
  let destinationState: unknown;
  function Destination() {
    destinationState = useLocation().state;
    return <div>Project workspace</div>;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/app/:projectSlug" element={<Destination />} />
        </Routes>
      </MemoryRouter>,
    );
  });

  const image = new File(["image bytes"], "storybook.png", { type: "image/png" });
  const secondImage = new File(["other bytes"], "detail.webp", { type: "image/webp" });
  const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(picker.multiple).toBe(true);
  Object.defineProperty(picker, "files", { configurable: true, value: [image, secondImage] });
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
  expect(container.querySelectorAll('button[aria-label^="Remove image "]')).toHaveLength(2);
  expect(container.querySelector('button[aria-label="Create project and send images"]')).not.toBeNull();

  await act(async () => {
    container?.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(createdName).toBe("storybook");
  expect(destinationState).toEqual({ initialImageFiles: [image, secondImage] });
  expect(container.textContent).toContain("Project workspace");
});
