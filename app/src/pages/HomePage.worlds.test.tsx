import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { HomePage } from "./HomePage";
import { PRODUCT_FEATURES, SHOWCASE_WORLDS } from "./homeShowcase";
import { HOME_FEATURES, HOME_WORLDS, HOME_LOCALE_KEY } from "./homeCopy";

/**
 * 首页新增的两段：搜索框下面的 4 个世界缩略图、以及产品特性段落。
 *
 * 这里钉的是**接线**而不是文案：卡数、缩略图地址、点击落点（真实世界 → 该项目工作台；
 * 占位世界 → 项目列表）、以及左右交替的排版。文案改了不该让测试红。
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
const originalSavedLocale = localStorage.getItem(HOME_LOCALE_KEY);
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => localStorage.removeItem(HOME_LOCALE_KEY));

function setLanguages(languages: string[]) {
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  if (originalLanguages) Object.defineProperty(navigator, "languages", originalLanguages);
  else Reflect.deleteProperty(navigator, "languages");
  if (originalSavedLocale === null) localStorage.removeItem(HOME_LOCALE_KEY);
  else localStorage.setItem(HOME_LOCALE_KEY, originalSavedLocale);
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

async function renderHome(languages = ["en-US"]) {
  setLanguages(languages);
  let location = "";
  function Probe() {
    location = `${useLocation().pathname}${useLocation().search}`;
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/app" element={<Probe />} />
          <Route path="/app/:projectSlug" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return () => location;
}

test("搜索框下面渲染 4 个世界缩略图，每张都有自己的图", async () => {
  await renderHome();

  const cards = Array.from(container!.querySelectorAll<HTMLButtonElement>("button[aria-label^='Enter world'], button[aria-label^='Browse projects']"));
  expect(cards).toHaveLength(4);
  expect(SHOWCASE_WORLDS).toHaveLength(4);

  const sources = cards.map((card) => card.querySelector("img")?.getAttribute("src"));
  expect(sources).toEqual(SHOWCASE_WORLDS.map((world) => world.thumbnail));
  // 4 张图必须互不相同，否则"4 个世界"名不副实
  expect(new Set(sources).size).toBe(4);
  // 缩略图是 3:2 的媒体位，别退化成自适应高度
  for (const card of cards) {
    expect(card.querySelector("img")?.className).toContain("object-cover");
  }
  // 卡面上除了世界名和标签，不该再有任何正文（介绍段落已按要求去掉）
  for (const [index, card] of cards.entries()) {
    const world = SHOWCASE_WORLDS[index]!;
    const text = (card.textContent ?? "")
      .replace(world.name, "")
      .replace(world.setting, "")
      .replace("Placeholder", "")
      .trim();
    expect({ world: world.id, leftover: text }).toEqual({ world: world.id, leftover: "" });
  }
});

test("中文浏览器显示中文标题、导航、输入提示和全部功能文案，世界跳转仍按原项目", async () => {
  const readLocation = await renderHome(["zh-CN", "en-US"]);
  expect(container!.querySelector(".home-landing")?.getAttribute("lang")).toBe("zh-CN");
  expect(container!.querySelector(".home-manifesto h2")?.textContent).toContain("会说话，就会建模");
  expect(container!.querySelector("nav")?.textContent).toContain("我的项目");
  expect(container!.querySelector("nav")?.textContent).toContain("创建项目");
  expect(container!.querySelector("#home-project-name")?.getAttribute("placeholder")).toBe("给你的新项目起个名字…");
  expect(Array.from(container!.querySelectorAll("article h3"), (el) => el.textContent)).toEqual(
    HOME_FEATURES["zh-CN"].map((feature) => feature.title),
  );
  expect(container!.querySelectorAll("article ul")).toHaveLength(0);
  expect(container!.querySelector("#cases-title")?.textContent).toBe("创作案例");

  const world = HOME_WORLDS["zh-CN"][0]!;
  const button = container!.querySelector<HTMLButtonElement>(`button[aria-label='进入世界：${world.name}']`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  expect(readLocation()).toBe(`/app/${world.projectSlug}`);
});

test("英文优先时保留英文，浏览器 languagechange 后更新整页中文文案", async () => {
  await renderHome(["en-US", "zh-CN"]);
  expect(container!.querySelector(".home-landing")?.getAttribute("lang")).toBe("en");
  expect(container!.querySelector("nav")?.textContent).toContain("Projects");
  expect(container!.querySelector(".home-manifesto h2")?.textContent).toContain("Say it, Model it");
  await act(async () => {
    setLanguages(["zh-TW"]);
    window.dispatchEvent(new Event("languagechange"));
  });
  expect(container!.querySelector(".home-landing")?.getAttribute("lang")).toBe("zh-CN");
  expect(container!.querySelector("nav")?.textContent).toContain("我的项目");
  expect(container!.querySelector("#features-title")?.textContent).toBe("会说，就会做");
  expect(container!.querySelector(".home-manifesto h2")?.textContent).toContain("会说话，就会建模");
});

test("点真实世界进它所在的项目工作台", async () => {
  const readLocation = await renderHome();

  const realWorld = SHOWCASE_WORLDS.find((world) => world.projectSlug)!;
  expect(realWorld).toBeDefined();

  const realButton = container!.querySelector<HTMLButtonElement>(`button[aria-label='Enter world ${realWorld.name}']`);
  expect(realButton).not.toBeNull();

  await act(async () => realButton!.click());
  expect(readLocation()).toBe(`/app/${realWorld.projectSlug}`);
});

test("中文 / EN 按钮即时切换并记住选择，保留附件且优先于浏览器语言变化", async () => {
  await renderHome(["en-US"]);
  URL.createObjectURL = () => "blob:language-preview";
  URL.revokeObjectURL = () => {};
  const image = new File(["image bytes"], "reference.png", { type: "image/png" });
  const picker = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, "files", { configurable: true, value: [image] });
  await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));

  await act(async () => container!.querySelector<HTMLButtonElement>('.home-language-switch button[lang="zh-CN"]')!.click());
  expect(container!.querySelector(".home-landing")?.getAttribute("lang")).toBe("zh-CN");
  expect(container!.querySelector('.home-language-switch button[lang="zh-CN"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(container!.querySelector("#features-title")?.textContent).toBe("会说，就会做");
  expect(container!.querySelector('button[aria-label="移除图片 reference.png"]')).not.toBeNull();
  expect(container!.querySelector('button[aria-label="创建项目并发送图片"]')).not.toBeNull();
  expect(localStorage.getItem(HOME_LOCALE_KEY)).toBe("zh-CN");

  await act(async () => {
    setLanguages(["en-GB"]);
    window.dispatchEvent(new Event("languagechange"));
  });
  expect(container!.querySelector(".home-landing")?.getAttribute("lang")).toBe("zh-CN");

  await act(async () => root!.unmount());
  container!.remove();
  await renderHome(["en-US"]);
  expect(container!.querySelector(".home-landing")?.getAttribute("lang")).toBe("zh-CN");

  await act(async () => container!.querySelector<HTMLButtonElement>('.home-language-switch button[lang="en"]')!.click());
  expect(container!.querySelector(".home-landing")?.getAttribute("lang")).toBe("en");
  expect(container!.querySelector('.home-language-switch button[lang="en"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(container!.querySelector("#features-title")?.textContent).toBe("What you can do");
  expect(localStorage.getItem(HOME_LOCALE_KEY)).toBe("en");
});

test("占位世界不点进空路由，而是回项目列表", async () => {
  const readLocation = await renderHome();

  const placeholderWorld = SHOWCASE_WORLDS.find((world) => !world.projectSlug)!;
  expect(placeholderWorld).toBeDefined();

  // 占位世界没有项目 slug：卡面用 Placeholder 角标说明身份，aria-label 说明点击会去哪
  const button = container!.querySelector<HTMLButtonElement>("button[aria-label^='Browse projects']");
  expect(button).not.toBeNull();
  expect(button!.getAttribute("aria-label")).toContain(placeholderWorld.name);
  expect(button!.textContent).toContain("Placeholder");

  await act(async () => button!.click());
  expect(readLocation()).toBe("/app");
});

test("渲染所有特性段落，录屏和静态图左右交替", async () => {
  await renderHome();

  expect(PRODUCT_FEATURES).toHaveLength(9);

  const articles = Array.from(container!.querySelectorAll("article"));
  expect(articles).toHaveLength(PRODUCT_FEATURES.length);
  expect(articles.map((article) => article.querySelector("h3")?.textContent)).toEqual(
    PRODUCT_FEATURES.map((feature) => feature.title),
  );

  for (const [index, article] of articles.entries()) {
    const feature = PRODUCT_FEATURES[index]!;
    if (feature.video) {
      const video = article.querySelector("video");
      expect(video?.getAttribute("src")).toBe(feature.video);
      expect(video?.autoplay).toBe(false);
      expect(video?.loop).toBe(true);
      expect(video?.muted).toBe(true);
      expect(video?.hasAttribute("playsinline")).toBe(true);
      expect(video?.preload).toBe("none");
      expect(video?.className).toContain("object-contain");
    }
    expect(article.querySelector(".home-cover-art")?.getAttribute("src")).toBe(feature.coverImage ?? `/landing/${feature.cover}.png`);
  }

  // 偶数行媒体在左（无 order），奇数行媒体推到右侧（lg:order-2）——这就是"左右交替"
  const mediaCells = articles.map((article) => article.firstElementChild as HTMLElement);
  expect(mediaCells.map((cell) => cell.className.includes("lg:order-2"))).toEqual(
    PRODUCT_FEATURES.map((_, index) => index % 2 === 1),
  );
  // 特性只保留标题、副标题与媒体，正文小字和箭头列表已按要求删除。
  for (const [index, article] of articles.entries()) {
    expect(article.querySelectorAll("p")).toHaveLength(1);
    expect(article.querySelector("p")?.textContent).toBe(PRODUCT_FEATURES[index]!.tagline);
    expect(article.querySelectorAll("ul")).toHaveLength(0);
  }
});
