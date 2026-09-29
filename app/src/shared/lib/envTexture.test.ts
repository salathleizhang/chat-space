import { expect, test } from "bun:test";
import { TextureLoader } from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { envLoaderFor } from "./envTexture";
import { resourcePath } from "../rendering/resourcePath";

test("repaired HDR/EXR generations change cache identity without changing loader", () => {
  for (const [path, loader] of [["/assets/sky.hdr", RGBELoader], ["/assets/sky.EXR", EXRLoader]] as const) {
    const oldURL = resourcePath(path, 0), repairedURL = resourcePath(path, 1);
    expect(oldURL).not.toBe(repairedURL);
    expect(envLoaderFor(oldURL)).toBe(loader);
    expect(envLoaderFor(repairedURL)).toBe(loader);
  }
});

test("image skyboxes and existing query strings retain the correct loader", () => {
  const url = resourcePath("/assets/sky.png?variant=preview", 2);
  expect(url).toBe("/assets/sky.png?variant=preview&revision=2");
  expect(envLoaderFor(url)).toBe(TextureLoader);
});
