import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { DESKTOP_ACTIVITY_SCRIPT, withDesktopActivity } from "./desktopActivity";

test("desktop activity reports only trusted input, ignores hover and throttles continuous dragging", () => {
  const handlers = new Map<string, (event: object) => void>(), requests: { url: string; options: RequestInit }[] = [];
  let now = 100_000;
  runInNewContext(DESKTOP_ACTIVITY_SCRIPT, {
    URL, Date: { now: () => now }, document: { currentScript: { src: "https://desktop.test/desktop/session/__lease/activity.js" } },
    window: { addEventListener: (type: string, handler: (event: object) => void) => handlers.set(type, handler) },
    fetch: (url: URL, options: RequestInit) => { requests.push({ url: url.href, options }); return Promise.resolve(); },
  });
  expect(requests).toHaveLength(0);
  handlers.get("pointermove")!({ type: "pointermove", isTrusted: true, buttons: 0 });
  handlers.get("keydown")!({ type: "keydown", isTrusted: false });
  expect(requests).toHaveLength(0);
  handlers.get("pointerdown")!({ type: "pointerdown", isTrusted: true });
  handlers.get("wheel")!({ type: "wheel", isTrusted: true });
  expect(requests).toHaveLength(1);
  now += 10_000;
  handlers.get("pointermove")!({ type: "pointermove", isTrusted: true, buttons: 1 });
  expect(requests).toHaveLength(2);
  expect(requests[0]!.url).toBe("https://desktop.test/desktop/session/__lease/activity");
  expect(requests[0]!.options).toMatchObject({ method: "POST", credentials: "same-origin", keepalive: true });
  expect(withDesktopActivity("<BODY>canvas</BODY>", "test-session")).toBe('<BODY>canvas<script src="/desktop/test-session/__lease/activity.js"></script></body>');
});
