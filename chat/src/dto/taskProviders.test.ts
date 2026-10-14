import { expect, test } from "bun:test";
import { Start3dBatchRequestSchema } from "./tasks";

test("HTTP 3D 默认选 Tripo，隐藏渠道不接受新任务", () => {
  const input = { projectSlug: "project", tripo3dApiKey: "fixture" };
  expect(Start3dBatchRequestSchema.parse(input).provider).toBe("tripo-direct");
  for (const provider of ["seed3d-direct", "hyper3d-volc", "hi3d-volc"]) {
    expect(Start3dBatchRequestSchema.safeParse({ ...input, provider }).success).toBe(false);
  }
});
