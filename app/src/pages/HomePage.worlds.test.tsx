import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { HomePage } from "./HomePage";
import { PRODUCT_FEATURES, SHOWCASE_WORLDS } from "./homeShowcase";

/**
 * 首页新增的两段：搜索框下面的 4 个世界缩略图、以及 10 个特性段落。
 *
 * 这里钉的是**接线**而不是文案：卡数、缩略图地址、点击落点（真实世界 → 该项目工作台；
 * 占位世界 → 项目列表）、以及左右交替的排版。文案改了不该让测试红。
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderHome() {
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

test("占位世界不点进空路由，而是回项目列表", async () => {
  const readLocation = await renderHome();

  const placeholderWorld = SHOWCASE_WORLDS.find((world) => !world.projectSlug)!;
  expect(placeholderWorld).toBeDefined();

  // 占位世界没有项目 slug，卡片自己就说明白点击会去哪，且 aria-label 带上世界名
  const button = container!.querySelector<HTMLButtonElement>("button[aria-label^='Browse projects']");
  expect(button).not.toBeNull();
  expect(button!.getAttribute("aria-label")).toContain(placeholderWorld.name);
  expect(button!.textContent).toContain("Browse projects");

  await act(async () => button!.click());
  expect(readLocation()).toBe("/app");
});

test("渲染 10 个特性段落，图像左右交替", async () => {
  await renderHome();

  expect(PRODUCT_FEATURES).toHaveLength(10);

  const articles = Array.from(container!.querySelectorAll("article"));
  expect(articles).toHaveLength(10);
  expect(articles.map((article) => article.querySelector("h3")?.textContent)).toEqual(
    PRODUCT_FEATURES.map((feature) => feature.title),
  );

  const images = articles.map((article) => article.querySelector("img")?.getAttribute("src"));
  expect(images).toEqual(PRODUCT_FEATURES.map((feature) => feature.image));

  // 偶数行媒体在左（无 order），奇数行媒体推到右侧（lg:order-2）——这就是"左右交替"
  const mediaCells = articles.map((article) => article.firstElementChild as HTMLElement);
  expect(mediaCells.map((cell) => cell.className.includes("lg:order-2"))).toEqual(
    PRODUCT_FEATURES.map((_, index) => index % 2 === 1),
  );
  // 每个特性都要有媒体块和 3 条要点，不能有段落缺图
  for (const article of articles) {
    expect(article.querySelectorAll("li")).toHaveLength(3);
  }
});
