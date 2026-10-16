import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { desktopDisplayScript, withDesktopDisplay } from "./desktopDisplay";

test("read-only desktop reports real frames only to configured parents and stops on page hide", () => {
  const sent: unknown[] = []; let connected = false, painted = true, tick!: () => void, hide!: () => void, cleared = false;
  const canvas = { id: "", width: 1024, height: 768, getBoundingClientRect: () => ({ width: 320 }) };
  runInNewContext(desktopDisplayScript("session-a", ["https://site.example"]), {
    document: { documentElement: { classList: { contains: () => connected } }, querySelectorAll: () => [
      { id: "noVNC_multiMonitorWidget", width: 2000, height: 1000, getBoundingClientRect: () => ({ width: 320 }) }, canvas,
    ],
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: (value: unknown) => expect(value).toBe(canvas), getImageData: () => ({ data: painted ? [40, 40, 40, 255] : [0, 0, 0, 255] }) }), toDataURL: () => painted ? "data:image/jpeg;base64,YWJj" : "data:image/jpeg;base64,Ymxhbms=" }) },
    parent: { postMessage: (data: unknown, origin: string) => sent.push({ data: JSON.parse(JSON.stringify(data)), origin }) },
    MutationObserver: class { observe() {} }, setInterval: (callback: () => void) => { tick = callback; return 1; },
    clearInterval: () => { cleared = true; }, window: { addEventListener: (_event: string, callback: () => void) => { hide = callback; } },
  });
  expect(sent).toEqual([{ origin: "https://site.example", data: { type: "chatspace-blender-display", session: "session-a", status: "connecting" } }]);
  connected = true; tick();
  expect(sent.at(-1)).toEqual({ origin: "https://site.example", data: { type: "chatspace-blender-display", session: "session-a", status: "connected", preview: "data:image/jpeg;base64,YWJj" } });
  painted = false; tick();
  expect(sent.at(-1)).toEqual({ origin: "https://site.example", data: { type: "chatspace-blender-display", session: "session-a", status: "connected", preview: "data:image/jpeg;base64,YWJj" } });
  hide(); expect(cleared).toBe(true);
  expect(withDesktopDisplay("<head></head><body></body>", "session-a")).toContain('display.js"></script></head>');
});
