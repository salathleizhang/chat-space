import { describe, expect, test } from "bun:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture } from "three";
import { DEFAULT_RESIDENT_BUDGET, ModelResources, resourceBytes } from "./ModelResources";
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

describe("trimToFit 按需腾内存", () => {
  test("释放到差额够为止，最旧的先走，返回实际释放量", () => {
    let now = 0;
    // idleBudget/寿命都给足，确保只有 trimToFit 在动手
    const cache = new ModelResources(Infinity, 100, 100000, () => now);
    const fixtures = [fixture(), fixture(), fixture()]; const clears: number[] = [];
    fixtures.forEach((model, index) => {
      now = index * 10;
      cache.acquire(model.root, () => clears.push(index))();
    });
    const total = fixtures.reduce((sum, model) => sum + resourceBytes(model.geometry), 0);

    // 只要 1 字节：最旧那一个就够了
    const first = cache.trimToFit(1);
    expect(clears).toEqual([0]);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(total);

    // 要剩下的全部
    const rest = cache.trimToFit(total);
    expect(clears).toEqual([0, 1, 2]);
    expect(first + rest).toBe(total);
    expect(cache.memory.residentBytes).toBe(0);
  });

  test("活动条目永不被释放，哪怕差额腾不出来", () => {
    const cache = new ModelResources(Infinity, 100, 100000);
    const active = fixture(); const idle = fixture();
    let activeClears = 0, disposed = 0;
    active.geometry.addEventListener("dispose", () => disposed++);
    const release = cache.acquire(active.root, () => activeClears++);
    cache.acquire(idle.root, () => {})();

    // 要一个远超空闲资源总量的差额
    const freed = cache.trimToFit(Number.MAX_SAFE_INTEGER);
    expect(freed).toBeGreaterThan(0);
    expect(activeClears).toBe(0);
    expect(disposed).toBe(0);
    expect(cache.stats.active).toBe(1);
    expect(cache.memory.residentBytes).toBeGreaterThan(0);
    release();
  });

  test("同一份资源被两个条目引用时只按一次计入驻留", () => {
    const cache = new ModelResources(Infinity, 100, 100000);
    const shared = fixture();
    const clone = fixture(shared.geometry, shared.material);
    const releaseA = cache.acquire(shared.root, () => {});
    const releaseB = cache.acquire(clone.root, () => {});
    expect(cache.memory.residentBytes).toBe(resourceBytes(shared.geometry));
    releaseA(); releaseB();
  });

  test("预算之内不淘汰；超预算时 sweep 立刻回收空闲条目", () => {
    let now = 0;
    // 缺省预算（512MB）下这点数据远远不够，所以什么都不该动
    const lenient = new ModelResources(Infinity, 100, 100000, () => now);
    // 显式给一个 1 字节的预算，模拟"驻留已超限"
    const strict = new ModelResources(Infinity, 100, 100000, () => now, 1);
    let lenientClears = 0, strictClears = 0;
    lenient.acquire(fixture().root, () => lenientClears++)();
    strict.acquire(fixture().root, () => strictClears++)();

    lenient.sweep();
    expect(lenientClears).toBe(0);
    expect(lenient.memory.overBudget).toBe(false);

    // sweep 之前它确实超预算；sweep 之后驻留归零，读数自然回到 false
    expect(strict.memory.overBudget).toBe(true);
    strict.sweep();
    expect(strictClears).toBe(1);           // 超预算：空闲条目立刻回收，不等寿命
    expect(strict.memory.trimmed).toBe(1);
    expect(strict.memory.overBudget).toBe(false);
  });

  test("缺省驻留预算是有限的，否则截图准入问不到模型侧还剩多少", () => {
    expect(Number.isFinite(new ModelResources().memory.residentLimit)).toBe(true);
    expect(new ModelResources().memory.residentLimit).toBe(DEFAULT_RESIDENT_BUDGET);
  });
});
