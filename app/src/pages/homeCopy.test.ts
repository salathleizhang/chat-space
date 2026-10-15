import { expect, test } from "bun:test";
import { HOME_ACTIONS, HOME_FEATURES, HOME_WORLDS, resolveHomeLocale } from "./homeCopy";
import { PRODUCT_FEATURES, SHOWCASE_WORLDS } from "./homeShowcase";

test.each([
  { languages: ["zh-CN", "en-US"], expected: "zh-CN" },
  { languages: ["zh-TW"], expected: "zh-CN" },
  { languages: ["zh-Hant-HK"], expected: "zh-CN" },
  { languages: ["zh"], expected: "zh-CN" },
  { languages: ["en-GB", "zh-CN"], expected: "en" },
  { languages: ["fr-FR", "zh-CN"], expected: "zh-CN" },
  { languages: ["ja-JP"], expected: "en" },
  { languages: [], expected: "en" },
])("browser preferences $languages resolve to $expected", ({ languages, expected }) => {
  expect(resolveHomeLocale(languages)).toBe(expected);
});

test("Chinese copy covers every feature and world without changing media or routing", () => {
  expect(HOME_FEATURES.en).toBe(PRODUCT_FEATURES);
  expect(HOME_WORLDS.en).toBe(SHOWCASE_WORLDS);
  for (const [index, feature] of HOME_FEATURES["zh-CN"].entries()) {
    const original = PRODUCT_FEATURES[index]!;
    expect(feature.title).not.toBe(original.title);
    expect(feature.tagline).not.toBe(original.tagline);
    expect({ id: feature.id, image: feature.image, video: feature.video }).toEqual({
      id: original.id, image: original.image, video: original.video,
    });
  }
  for (const [index, world] of HOME_WORLDS["zh-CN"].entries()) {
    const original = SHOWCASE_WORLDS[index]!;
    expect(world.name).not.toBe(original.name);
    expect({ id: world.id, thumbnail: world.thumbnail, projectSlug: world.projectSlug }).toEqual({
      id: original.id, thumbnail: original.thumbnail, projectSlug: original.projectSlug,
    });
  }
  expect(HOME_ACTIONS["zh-CN"]).toEqual(["建模", "展 UV", "拓扑", "贴图", "绑骨", "动画"]);
});
