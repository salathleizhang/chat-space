import { expect, test } from "bun:test";
import { Start3dBatchRequestSchema } from "./tasks";

test("HTTP 3D 默认走 Seed3D，火山三个渠道都接受，Tripo 需要自己的 key", () => {
  const input = { projectSlug: "project", seed3dApiKey: "fixture" };
  expect(Start3dBatchRequestSchema.parse(input).provider).toBe("seed3d-direct");
  for (const provider of ["seed3d-direct", "hyper3d-volc", "hi3d-volc"]) {
    expect(Start3dBatchRequestSchema.safeParse({ ...input, provider }).success).toBe(true);
  }
  // Tripo 分支还保留（历史重试），但必须带它自己的 key
  expect(Start3dBatchRequestSchema.safeParse({ ...input, provider: "tripo-direct" }).success).toBe(false);
  expect(
    Start3dBatchRequestSchema.safeParse({
      projectSlug: "project",
      provider: "tripo-direct",
      tripo3dApiKey: "tsk",
    }).success,
  ).toBe(true);
});

test("没给 key 的火山请求被拒绝", () => {
  expect(Start3dBatchRequestSchema.safeParse({ projectSlug: "project" }).success).toBe(false);
});
