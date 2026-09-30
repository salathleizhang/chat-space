import { expect, test } from "bun:test";
import {
  clearModelDescription,
  getModelDescription,
  listModelDescriptions,
  publishModelDescription,
  resetModelDescriptions,
  subscribeModelDescriptions,
  type ModelDescription,
} from "./modelDescription";

const describe = (over: Partial<ModelDescription> = {}): ModelDescription => ({
  status: "ready",
  supportedSlots: ["map"],
  channels: new Map([["map", { materialName: "M", width: 8, height: 8, dataUrl: "data:," }]]),
  ...over,
});

test("publish 后可读；clear 后不可读", () => {
  resetModelDescriptions();
  publishModelDescription("a", describe());
  expect(getModelDescription("a")?.status).toBe("ready");
  clearModelDescription("a");
  expect(getModelDescription("a")).toBeUndefined();
});

test("每次 publish / clear 都通知订阅者，**即使 size 不变**", () => {
  // 这是把快照从 size 改成版本号的原因：同一个 slug 重新 publish（模型换代）时 size 不变，
  // 用 size 会让 Inspector 收不到通知、停在旧缩略图上。
  resetModelDescriptions();
  let notifications = 0;
  const unsubscribe = subscribeModelDescriptions(() => { notifications += 1; });
  publishModelDescription("a", describe());
  expect(notifications).toBe(1);
  publishModelDescription("a", describe({ status: "error", error: "boom" }));
  expect(notifications).toBe(2); // size 仍是 1，但必须通知
  clearModelDescription("a");
  expect(notifications).toBe(3);
  clearModelDescription("a"); // 不存在的 slug：不通知
  expect(notifications).toBe(3);
  unsubscribe();
  publishModelDescription("b", describe());
  expect(notifications).toBe(3); // 退订后不再收到
});

test("描述数量有上界，且重新 publish 会让该条目变成最近使用", () => {
  resetModelDescriptions();
  for (let i = 0; i < 40; i += 1) publishModelDescription(`slug-${i}`, describe());
  // 上限 32：最早的被淘汰
  expect(getModelDescription("slug-0")).toBeUndefined();
  expect(getModelDescription("slug-39")).toBeDefined();

  // 把还在的前几条里最早的那条重新 publish，它应当被保下来
  const oldestSurvivor = "slug-8";
  expect(getModelDescription(oldestSurvivor)).toBeDefined();
  publishModelDescription(oldestSurvivor, describe({ status: "loading" }));
  for (let i = 40; i < 45; i += 1) publishModelDescription(`slug-${i}`, describe());
  expect(getModelDescription(oldestSurvivor)?.status).toBe("loading");
});

test("模型换代时旧描述被整对象替换（不是原地改）", () => {
  resetModelDescriptions();
  const first = describe({ supportedSlots: ["map"] });
  publishModelDescription("a", first);
  const second = describe({ supportedSlots: ["map", "normalMap"] });
  publishModelDescription("a", second);
  expect(getModelDescription("a")).toBe(second);
  expect(getModelDescription("a")).not.toBe(first);
});

test("listModelDescriptions 能列出全部描述（诊断探针读它来确认生产方真的发布了）", () => {
  resetModelDescriptions();
  publishModelDescription("a", describe());
  publishModelDescription("b", describe({ status: "error", error: "boom" }));
  const listed = listModelDescriptions();
  expect(listed.map((entry) => entry.assetId).sort()).toEqual(["a", "b"]);
  expect(listed.find((entry) => entry.assetId === "b")!.description.error).toBe("boom");
});
