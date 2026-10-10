import { expect, test } from "bun:test";
import { VolcanoSandboxes, VolcanoError } from "./volcano";
const settings = { accessKeyId: "test-ak", secretKey: "test-secret", region: "cn-beijing", functionId: "201j2k8z", imageInfoId: "verified-image-id" };
test("sandbox creation pins the preheated image, 8080 entrypoint and independent lease credentials using the documented nested schema", async () => {
  const calls: { action: string; input: any }[] = [];
  const fetcher = (async (address: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers); expect(headers.get("authorization")).toContain("Credential=test-ak");
    const action = new URL(String(address)).searchParams.get("Action")!, input = JSON.parse(String(init?.body)); calls.push({ action, input });
    return Response.json({ Result: { SandboxId: `sandbox-${calls.length}` } });
  }) as unknown as typeof fetch;
  const cloud = new VolcanoSandboxes(settings, fetcher);
  await cloud.create("first", 1, { control: "first-control", desktop: "first-desktop" }, 20);
  await cloud.create("second", 1, { control: "second-control", desktop: "second-desktop" }, 20);
  expect(calls[0]!.input.InstanceImageInfo).toEqual({ Id: "verified-image-id", Port: 8080, Command: "/opt/cloud-gateway/entrypoint.sh" });
  expect(calls[0]!.input.InstanceImageInfoId).toBeUndefined(); expect(calls[0]!.input.Timeout).toBe(20);
  expect(calls[0]!.input.CpuMilli).toBe(8000); expect(calls[0]!.input.MemoryMB).toBe(32768);
  expect(calls[0]!.input.Metadata.chatspace_session).not.toBe(calls[1]!.input.Metadata.chatspace_session);
  expect(calls[0]!.input.Envs).not.toEqual(calls[1]!.input.Envs);
});
test("mutation response loss is explicitly unknown and never automatically retried by the adapter", async () => {
  let calls = 0;
  const cloud = new VolcanoSandboxes(settings, (async () => { calls++; throw new Error("after-provider-accepted"); }) as unknown as typeof fetch);
  try { await cloud.create("session", 1, { control: "fixture", desktop: "fixture" }); throw new Error("Expected unknown"); }
  catch (error) { expect(error).toBeInstanceOf(VolcanoError); expect((error as VolcanoError).unknown).toBe(true); }
  expect(calls).toBe(1);
});
test("resuming uses the remaining runtime allowance instead of granting another hour", async () => {
  let body: any;
  const cloud = new VolcanoSandboxes(settings, (async (_url, init) => {
    body = JSON.parse(String(init?.body)); return Response.json({ Result: { SandboxId: "resumed" } });
  }) as typeof fetch);
  await cloud.resume("sandbox", 7); expect(body.Timeout).toBe(7);
  expect(body.SandboxId).toBe("sandbox");
  await expect(cloud.resume("sandbox", 61)).rejects.toThrow();
});
