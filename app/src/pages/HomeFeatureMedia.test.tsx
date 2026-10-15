import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FeatureMedia } from "./HomeFeatureMedia";
import { HOME_COPY } from "./homeCopy";
import { PRODUCT_FEATURES } from "./homeShowcase";

let root: Root | null = null;
let container: HTMLDivElement;
const originalPlay = HTMLMediaElement.prototype.play;
const originalPause = HTMLMediaElement.prototype.pause;
let play = mock(() => Promise.resolve());
let pause = mock(() => {});

beforeEach(() => {
  play = mock(() => Promise.resolve());
  pause = mock(() => {});
  HTMLMediaElement.prototype.play = play;
  HTMLMediaElement.prototype.pause = pause;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  HTMLMediaElement.prototype.play = originalPlay;
  HTMLMediaElement.prototype.pause = originalPause;
});

async function renderMedia(index = 0) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<FeatureMedia feature={PRODUCT_FEATURES[index]!} copy={HOME_COPY.en} />));
  return {
    host: container.querySelector<HTMLButtonElement>("button")!,
    video: container.querySelector<HTMLVideoElement>("video")!,
    cover: container.querySelector<HTMLElement>(".home-feature-cover")!,
  };
}

async function pointer(host: HTMLElement, type: "pointerover" | "pointerout", pointerType = "mouse") {
  await act(async () => host.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget: document.body })));
}

test("default cover stays visible until hovered video plays; leaving pauses and rewinds", async () => {
  const { host, video, cover } = await renderMedia();
  expect(video.autoplay).toBe(false);
  expect(video.preload).toBe("none");
  expect(play).toHaveBeenCalledTimes(0);
  expect(cover.getAttribute("aria-hidden")).toBe("false");
  expect(cover.querySelector("img")?.getAttribute("src")).toBe("/landing/composer.png");
  expect(cover.querySelector(".home-cover-cursor")?.getAttribute("src")).toBe("/landing/cursor.png");

  await pointer(host, "pointerover");
  expect(play).toHaveBeenCalledTimes(1);
  expect(host.getAttribute("data-playing")).toBe("false");
  await act(async () => video.dispatchEvent(new Event("playing")));
  expect(host.getAttribute("data-playing")).toBe("true");
  expect(cover.getAttribute("aria-hidden")).toBe("true");

  video.currentTime = 5;
  pause.mockClear();
  await pointer(host, "pointerout");
  expect(pause.mock.calls.length).toBeGreaterThan(0);
  expect(video.currentTime).toBe(0);
  expect(host.getAttribute("aria-pressed")).toBe("false");
  expect(cover.getAttribute("aria-hidden")).toBe("false");
});

test("touch enter does not autoplay; clicking toggles playback and touch leave preserves it", async () => {
  const { host, video } = await renderMedia();
  await pointer(host, "pointerover", "touch");
  expect(play).toHaveBeenCalledTimes(0);
  await act(async () => host.click());
  expect(play).toHaveBeenCalledTimes(1);
  await act(async () => video.dispatchEvent(new Event("playing")));
  await pointer(host, "pointerout", "touch");
  expect(host.getAttribute("data-playing")).toBe("true");
  await act(async () => host.click());
  expect(host.getAttribute("data-playing")).toBe("false");
  expect(host.getAttribute("aria-pressed")).toBe("false");
});

test("rejected playback keeps the artwork visible and allows another attempt", async () => {
  play.mockRejectedValueOnce(new Error("Playback blocked"));
  const { host, cover } = await renderMedia();
  await pointer(host, "pointerover");
  expect(host.getAttribute("aria-pressed")).toBe("false");
  expect(cover.getAttribute("aria-hidden")).toBe("false");
  await act(async () => host.click());
  expect(play).toHaveBeenCalledTimes(2);
});

test("a cancelled play rejection cannot stop a newer hover, and late playing after leave stays hidden", async () => {
  let rejectOld!: (error: Error) => void;
  const oldPlay = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
  play.mockImplementationOnce(() => oldPlay);
  const { host, video } = await renderMedia();
  await pointer(host, "pointerover");
  await pointer(host, "pointerout");
  await act(async () => video.dispatchEvent(new Event("playing")));
  expect(host.getAttribute("data-playing")).toBe("false");
  await pointer(host, "pointerover");
  await act(async () => video.dispatchEvent(new Event("playing")));
  await act(async () => rejectOld(new Error("Old play interrupted")));
  expect(host.getAttribute("data-playing")).toBe("true");
  expect(host.getAttribute("aria-pressed")).toBe("true");
});

test("media errors and window blur restore the static cover", async () => {
  const { host, video, cover } = await renderMedia();
  await pointer(host, "pointerover");
  await act(async () => video.dispatchEvent(new Event("playing")));
  await act(async () => video.dispatchEvent(new Event("error")));
  expect(cover.getAttribute("aria-hidden")).toBe("false");
  expect(host.getAttribute("aria-pressed")).toBe("false");
  await act(async () => host.click());
  await act(async () => video.dispatchEvent(new Event("playing")));
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(host.getAttribute("data-playing")).toBe("false");
  expect(host.getAttribute("aria-pressed")).toBe("false");
});

test("a feature without a recording has a static cover and no inactive play button", async () => {
  await renderMedia(3);
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("video")).toBeNull();
  expect(container.querySelector(".home-cover-art")?.getAttribute("src")).toBe("/landing/retopology.png");
});
