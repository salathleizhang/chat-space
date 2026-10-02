import { expect, test } from "bun:test";
import { waitForSeed3dTask } from "./seed3d";

/**
 * 火山 3D 三家（Seed3D / 影眸 Hyper3D / 数美 Hi3D）共用这套等待器。文案必须跟着
 * `label` 走，否则 Hi3D 的失败会写成「Seed3D 任务超时」，把排查带偏
 * （2026-10-02 的真实事故：三条 Hi3D/Hyper3D 任务全被记成 Seed3D）。
 */

const alwaysRunning = (async (_input: string | URL | Request, _init?: RequestInit) =>
  Response.json({ status: "running" })) as typeof fetch;

test("超时文案用调用方给的主语，不再写死 Seed3D", async () => {
  await expect(
    waitForSeed3dTask("cgt-hi3d", {
      apiKey: "k",
      label: "Hi3D",
      fetchFn: alwaysRunning,
      timeoutMs: 60,
      pollIntervalMs: 1,
    }),
  ).rejects.toThrow("Hi3D 任务超时（id=cgt-hi3d，可凭侧写续查）");
});

test("缺省主语仍是 Seed3D（直连渠道不受影响）", async () => {
  await expect(
    waitForSeed3dTask("cgt-seed", {
      apiKey: "k",
      fetchFn: alwaysRunning,
      timeoutMs: 60,
      pollIntervalMs: 1,
    }),
  ).rejects.toThrow("Seed3D 任务超时（id=cgt-seed，可凭侧写续查）");
});

test("终态失败的文案也带主语", async () => {
  const failed = (async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ status: "failed", error: { message: "nope" } })) as typeof fetch;
  await expect(
    waitForSeed3dTask("cgt-x", { apiKey: "k", label: "Hyper3D", fetchFn: failed }),
  ).rejects.toThrow("Hyper3D 任务失败：nope");
});
