import { afterEach, describe, expect, mock, test } from "bun:test";
import { BlenderCloudClient, cloudBudget, readBlenderCloudSettings } from "./blenderCloud";
import { tickTaskPumps } from "../common/taskPump";

const settings = { target: "https://gateway.example/", token: "Test_Control_Token_1234567890123456",
  instanceName: "sandbox-test", projectSlug: "test-project" };
const originalTimers = globalThis.setTimeout;
afterEach(() => { globalThis.setTimeout = originalTimers; });

describe("cloud Blender transport", () => {
  test("rejects partial configuration, URL credentials and public HTTP", () => {
    expect(readBlenderCloudSettings({})).toBeNull();
    const env = { BLENDER_CONTROL_TOKEN: settings.token, BLENDER_CLOUD_PROJECT: settings.projectSlug,
      BLENDER_LIVE_TARGET: settings.target, BLENDER_LIVE_INSTANCE_NAME: settings.instanceName };
    expect(readBlenderCloudSettings(env)).toEqual(settings);
    for (const target of ["http://gateway.example", "https://user:pass@gateway.example", "https://gateway.example/control"])
      expect(() => readBlenderCloudSettings({ ...env, BLENDER_LIVE_TARGET: target })).toThrow();
    expect(() => readBlenderCloudSettings({ BLENDER_CLOUD_PROJECT: "test-project" })).toThrow();
  });

  test("uses server token and same instance, suppresses secret diagnostics, rejects excluded tools", async () => {
    const requests: Request[] = [];
    const client = new BlenderCloudClient(settings, mock(async (url, init) => {
      requests.push(new Request(url, init));
      return Response.json({ content: [{ type: "text", text: '{"objects":3}' }] });
    }) as unknown as typeof fetch);
    const result = await client.call("get_scene_info");
    expect(result.json).toEqual({ objects: 3 });
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${settings.token}`);
    expect(requests[0]?.headers.get("x-faas-instance-name")).toBe(settings.instanceName);
    expect(await requests[0]?.json()).toEqual({ tool: "get_scene_info", arguments: {} });
    expect(JSON.stringify(client.diagnostics)).not.toContain(settings.token);
    await expect(client.call("generate_tripo_model")).rejects.toThrow("白名单");
    expect(requests).toHaveLength(1);
  });

  test("never replays a command on HTTP errors and leaves the next request usable", async () => {
    let calls = 0;
    const client = new BlenderCloudClient(settings, mock(async () => {
      calls++;
      return calls === 1 ? new Response("secret upstream diagnostics", { status: 504 }) :
        Response.json({ content: [{ type: "text", text: "ok" }] });
    }) as unknown as typeof fetch);
    await expect(client.call("execute_blender_code", { code: "do_non_idempotent_work()" })).rejects.toThrow("HTTP 504");
    expect(calls).toBe(1);
    expect((await client.call("get_scene_info")).text).toBe("ok");
    expect(calls).toBe(2);
  });

  test("serializes commands so parallel calls cannot swap scene responses", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const tools: string[] = [];
    const client = new BlenderCloudClient(settings, mock(async (_url, init) => {
      const tool = JSON.parse(init!.body as string).tool;
      tools.push(tool);
      if (tool === "get_scene_info") await blocked;
      return Response.json({ content: [{ type: "text", text: tool }] });
    }) as unknown as typeof fetch);
    const first = client.call("get_scene_info");
    const second = client.call("get_object_info", { object_name: "Cube" });
    await Promise.resolve(); await Promise.resolve();
    expect(tools).toEqual(["get_scene_info"]);
    release();
    expect((await first).text).toBe("get_scene_info");
    expect((await second).text).toBe("get_object_info");
  });

  test("file transfer checks IDs, size bounds and fetches bytes over HTTP, never local paths", async () => {
    const requests: string[] = [];
    const client = new BlenderCloudClient(settings, mock(async (url, init) => {
      requests.push(`${init?.method} ${url}`);
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(new Uint8Array([103, 108, 84, 70]));
    }) as unknown as typeof fetch);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(await client.downloadExport(id)).toEqual(new Uint8Array([103, 108, 84, 70]));
    await client.removeExport(id);
    expect(requests).toEqual([`GET ${settings.target}control/exports/${id}`, `DELETE ${settings.target}control/exports/${id}`]);
    expect(() => client.downloadExport("../../etc/passwd")).toThrow();
    const tooLarge = new BlenderCloudClient(settings, mock(async () => new Response("x", {
      headers: { "Content-Length": String(256 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch);
    await expect(tooLarge.downloadExport(id)).rejects.toThrow("上限");
  });

  test("dead timers plus external task tick still abort a stalled request", async () => {
    globalThis.setTimeout = (() => 1) as unknown as typeof setTimeout;
    const clock = Date.now;
    let now = 100;
    Date.now = () => now;
    let aborted = false;
    try {
      const pending = cloudBudget((signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        return new Promise(() => {});
      }, 50);
      const failure = pending.catch((error: Error) => error);
      now = 149;
      tickTaskPumps();
      expect(aborted).toBe(false);
      now = 150;
      tickTaskPumps();
      expect((await failure as Error).message).toContain("执行结果未知");
      expect(aborted).toBe(true);
    } finally { Date.now = clock; }
  });
});
