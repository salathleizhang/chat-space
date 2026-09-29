import { expect, test } from "bun:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture } from "three";
import { ModelResources, resourceBytes } from "./ModelResources";
import { resourcePath } from "./resourcePath";

function fixture(geometry = new BoxGeometry(), material = new MeshBasicMaterial()) {
  const root = new Group(); root.add(new Mesh(geometry, material)); return { root, geometry, material };
}

test("cache eviction never disposes resources still leased by another consumer", () => {
  const cache = new ModelResources(0, 0);
  const a = fixture(), b = fixture(a.geometry, a.material);
  let clears = 0, disposed = 0;
  a.geometry.addEventListener("dispose", () => disposed++);
  const releaseA = cache.acquire(a.root, () => clears++);
  const releaseA2 = cache.acquire(a.root, () => clears++);
  const releaseB = cache.acquire(b.root, () => clears++);
  releaseA(); cache.sweep();
  expect(clears).toBe(0);
  releaseA2(); cache.sweep();
  expect(clears).toBe(1); expect(disposed).toBe(0);
  releaseB(); cache.sweep();
  expect(clears).toBe(2); expect(disposed).toBe(1);
  expect(cache.stats).toEqual({ entries: 0, active: 0, estimatedBytes: 0, evicted: 2 });
});

test("StrictMode reacquires before cleanup; releases are idempotent", () => {
  const cache = new ModelResources(0, 0); const model = fixture();
  let clears = 0;
  const release = cache.acquire(model.root, () => clears++);
  release(); release();
  const reclaimed = cache.acquire(model.root, () => clears++);
  cache.sweep(); expect(clears).toBe(0); expect(cache.stats.active).toBe(1);
  reclaimed(); cache.sweep(); expect(clears).toBe(1);
});

test("idle LRU has bounded entries and expires unused models", () => {
  let now = 0;
  const cache = new ModelResources(Infinity, 1, 100, () => now);
  const a = fixture(), b = fixture(); const clears: string[] = [];
  cache.acquire(a.root, () => clears.push("a"))();
  now = 10; cache.acquire(b.root, () => clears.push("b"))();
  cache.sweep(); expect(clears).toEqual(["a"]); expect(cache.stats.entries).toBe(1);
  now = 200; cache.sweep(); expect(clears).toEqual(["a", "b"]); expect(cache.stats.entries).toBe(0);
});

test("estimates geometry and texture storage and separates repaired generations", () => {
  const geometry = new BoxGeometry(); const texture = new Texture({ width: 1024, height: 1024 });
  expect(resourceBytes(geometry)).toBeGreaterThan(0);
  expect(resourceBytes(texture)).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  expect(resourcePath("model.glb")).toBe("model.glb?revision=0");
  expect(resourcePath("model.glb", 3)).toBe("model.glb?revision=3");
  expect(resourcePath("model.glb?x=1", 2)).toBe("model.glb?x=1&revision=2");
  geometry.dispose(); texture.dispose();
});
