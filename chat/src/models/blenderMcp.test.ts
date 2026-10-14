import { afterEach, describe, expect, test } from "bun:test";
import { ChatServiceError } from "../common/errors";
import {
  BLENDER_ALLOWED_TOOLS,
  BLENDER_BLOCKED_TOOLS,
  BlenderMcpClient,
  addonStatusFromText,
  wrapResult,
} from "./blenderMcp";

/**
 * 白名单是**硬闸门**，不是提示词纪律，所以它必须有会失败的测试。
 *
 * 这一组的意义不在于"名单内容对不对"，而在于**任何人往名单里加东西都会红**：
 * 生成器会与本仓库既有的 Tripo / Hyper3D / Hunyuan 付费管线重复计费；
 * 资产市场是提示注入面（社区版自己的 `safe_mode.py` 点名过 Poly Haven / Sketchfab
 * 的资产名与描述），且经 Blender 下载的资产拿不到稳定 asset id、摆不进 `scene.json`。
 */
describe("Blender 工具白名单", () => {
  test("恰好是这 8 个工具", () => {
    expect([...BLENDER_ALLOWED_TOOLS].sort()).toEqual([
      "bpy_api_lookup",
      "describe_node_type",
      "execute_blender_code",
      "export_scene",
      "get_addon_status",
      "get_object_info",
      "get_scene_info",
      "get_viewport_screenshot",
    ]);
  });

  test("三个生成器全部被排除（重复付费）", () => {
    for (const name of [
      "generate_tripo_model",
      "generate_hyper3d_model_via_text",
      "generate_hyper3d_model_via_images",
      "generate_hunyuan3d_model",
    ]) {
      expect(BLENDER_ALLOWED_TOOLS as readonly string[]).not.toContain(name);
      expect(BLENDER_BLOCKED_TOOLS as readonly string[]).toContain(name);
    }
  });

  test("三个资产市场全部被排除（提示注入 + 绕过资产库）", () => {
    for (const name of [
      "search_polyhaven_assets",
      "download_polyhaven_asset",
      "download_sketchfab_model",
      "download_polypizza_model",
      "set_texture",
    ]) {
      expect(BLENDER_ALLOWED_TOOLS as readonly string[]).not.toContain(name);
      expect(BLENDER_BLOCKED_TOOLS as readonly string[]).toContain(name);
    }
  });

  test("两份名单不重叠（重叠等于自相矛盾）", () => {
    const allowed = new Set<string>(BLENDER_ALLOWED_TOOLS);
    const overlap = BLENDER_BLOCKED_TOOLS.filter((name) => allowed.has(name));
    expect(overlap).toEqual([]);
  });
});

describe("wrapResult", () => {
  test("content[].text 是 JSON 时解析出来", () => {
    const { text, json } = wrapResult("x", {
      content: [{ type: "text", text: '{"objectCount":3}' }],
    });
    expect(text).toBe('{"objectCount":3}');
    expect(json).toEqual({ objectCount: 3 });
  });

  test("非 JSON 文本原样交回，json 为 null", () => {
    const { text, json } = wrapResult("x", { content: [{ type: "text", text: "done" }] });
    expect(text).toBe("done");
    expect(json).toBeNull();
  });

  test("多段 text 拼接", () => {
    const { text } = wrapResult("x", {
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "..." },
        { type: "text", text: "b" },
      ],
    });
    expect(text).toBe("a\nb");
  });

  test("没有 content 时 text 与 json 都是空的 —— null 的含义是「没解析出来」", () => {
    expect(wrapResult("x", {})).toEqual({ text: "", json: null, isError: false });
    expect(wrapResult("x", null)).toEqual({ text: "", json: null, isError: false });
  });

  test("透传协议层的 isError —— 但它不足以判断业务失败", () => {
    expect(wrapResult("x", { content: [], isError: true }).isError).toBe(true);
    expect(wrapResult("x", { content: [], isError: false }).isError).toBe(false);
  });
});

/**
 * 真机验证抓到的形态：Blender 没跑时，`get_addon_status` 返回的是**成功结果**，
 * `isError` 是 false，失败写在文本里。照 isError 判断会得到 `connected: true` 的假阳性。
 */
describe("addonStatusFromText", () => {
  test("识别「连不上 Blender」的成功结果", () => {
    const text =
      "Error checking addon status: Could not connect to Blender. " +
      "Make sure the Blender addon is running.";
    expect(addonStatusFromText(text).connected).toBe(false);
  });

  test("正常状态文本判为已连接", () => {
    expect(addonStatusFromText('{"addon":"MCP for Blender","version":"1.8"}').connected).toBe(
      true,
    );
    expect(addonStatusFromText("").connected).toBe(true);
  });
});

const FAKE = new URL("./blenderMcpFake.testkit.ts", import.meta.url).pathname;

function fakeClient(overrides: { callTimeoutMs?: number } = {}) {
  return new BlenderMcpClient({
    bin: process.execPath,
    args: [FAKE],
    // 假 server 默认复刻"Blender 没连上"；要测真正的调用路径就显式打开。
    env: { FAKE_BLENDER_CONNECTED: "1" },
    callTimeoutMs: overrides.callTimeoutMs ?? 5_000,
  });
}

/** 假 server 处于「Blender 没连上」状态 —— 真机上最常见的状态。 */
function disconnectedClient(overrides: { callTimeoutMs?: number } = {}) {
  return new BlenderMcpClient({
    bin: process.execPath,
    args: [FAKE],
    callTimeoutMs: overrides.callTimeoutMs ?? 5_000,
  });
}

let client: BlenderMcpClient | null = null;

afterEach(async () => {
  await client?.stop();
  client = null;
});

describe("BlenderMcpClient 端到端（假 server，无 Blender）", () => {
  test("启动、握手、调用、取回解析后的 JSON", async () => {
    client = fakeClient();
    const result = await client.call("get_scene_info");
    expect(result.tool).toBe("get_scene_info");
    expect(result.json).toEqual({ received: { user_prompt: "" } });
  });

  test("user_prompt 由本层统一注入（模型看不见它）", async () => {
    client = fakeClient();
    const result = await client.call("execute_blender_code", { code: "nop" });
    // 假 server 回显收到的 arguments：code 原样在，user_prompt 被补上了
    expect(result.json).toEqual({ received: { code: "nop", user_prompt: "" } });
  });

  test("白名单外的工具在 spawn 之前就被拒，且进程不会被拉起来", async () => {
    client = fakeClient();
    await expect(client.call("generate_tripo_model")).rejects.toThrow(/allowlist/);
    // 关键：拒绝发生在启动之前 —— 不能让一个"只是想调 Tripo"的调用把 Blender 拉起来
    expect(client.running).toBe(false);
  });

  test("调用超时给出可诊断的错误，并且提示要拆小步", async () => {
    client = fakeClient({ callTimeoutMs: 800 });
    await expect(
      client.call("execute_blender_code", { code: "hang" }),
    ).rejects.toThrow(/smaller steps/);
  });

  test("进程在调用中途退出 → 在飞的调用被拒（而不是永远挂着）", async () => {
    client = fakeClient({ callTimeoutMs: 10_000 });
    await expect(
      client.call("execute_blender_code", { code: "exit" }),
    ).rejects.toThrow(/exited|write the request/);
  });

  test("并发调用被串行化：两个都成功且各自拿到自己的结果", async () => {
    client = fakeClient({ callTimeoutMs: 10_000 });
    const [first, second] = await Promise.all([
      client.call("execute_blender_code", { code: "sleep:120" }),
      client.call("execute_blender_code", { code: "second" }),
    ]);
    expect(first.json).toEqual({ received: { code: "sleep:120", user_prompt: "" } });
    expect(second.json).toEqual({ received: { code: "second", user_prompt: "" } });
  });

  test("start() 幂等：重复调用不会重复拉起进程", async () => {
    client = fakeClient();
    await client.start();
    await client.start();
    expect(client.running).toBe(true);
    const result = await client.call("get_addon_status");
    expect(result.json).toEqual({ received: { user_prompt: "" } });
  });

  test("stop() 之后可以把进程重新拉起来（服务重启自愈的前提）", async () => {
    client = fakeClient();
    await client.call("get_scene_info");
    await client.stop();
    expect(client.running).toBe(false);
    const again = await client.call("get_scene_info");
    expect(again.json).toEqual({ received: { user_prompt: "" } });
  });
});

/**
 * 这一组是**真机验证抓回来的**，两个 bug 同源：社区版把"连不上 Blender"当成成功结果
 * 返回（失败在文本里，`isError` 是 false）。
 *
 * 不修的话后果是：会话检查报 `connected: true`（假阳性），且存活闸门形同虚设——
 * 后续 `execute_blender_code` 会一直挂到默认预算（实测 300 秒）才失败，
 * 而错误信息还说"这一步跑太久"，完全指错方向。
 */
describe("Blender 不在时的快速失败", () => {
  test("会话检查报告未连接（不是假阳性）", async () => {
    client = disconnectedClient();
    const result = await client.call("get_addon_status", {}, { timeoutMs: 10_000 });
    expect(result.isError).toBe(false); // 协议层"成功"
    expect(addonStatusFromText(result.text).connected).toBe(false); // 业务层"没连上"
  });

  test("执行类调用快速失败，而不是拖满调用预算", async () => {
    // 预算给到 60 秒；如果闸门失效，这个测试会跑满 60 秒才红。
    client = disconnectedClient({ callTimeoutMs: 60_000 });
    const started = Date.now();
    const error = (await client
      .call("execute_blender_code", { code: "print(1)" })
      .catch((thrown: unknown) => thrown)) as ChatServiceError;
    const elapsed = Date.now() - started;

    expect(error.code).toBe("blender_not_connected");
    expect(error.message).toContain("Blender");
    // 关键判据：远小于调用预算，说明走的是存活闸门而不是"等它超时"
    expect(elapsed).toBeLessThan(20_000);
  });

  test("探测结果有缓存：连续调用不会每次都白等一轮", async () => {
    client = disconnectedClient({ callTimeoutMs: 60_000 });
    await client.call("get_scene_info").catch(() => undefined);
    const started = Date.now();
    await client.call("get_scene_info").catch(() => undefined);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/**
 * 真机验证抓到的第三个 bug：`stop()` 只杀启动器，**子进程变成孤儿**。
 *
 * `uvx` 会 fork 出真正干活的 python 服务。只 `kill()` uvx 的后果有两个：孤儿继续占着
 * stdout/stderr 管道（Bun 进程因此不退出），以及长跑服务里"每停一次泄漏一个 MCP server"。
 * 假 server 用 `code: "spawn-child"` 复刻这个形状。
 */
describe("stop() 杀掉整棵进程树", () => {
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  test("由 server 拉起的孙进程也被清掉", async () => {
    client = fakeClient({ callTimeoutMs: 15_000 });
    const started = await client.call("execute_blender_code", { code: "spawn-child" });
    const match = /childPid":(\d+)/.exec(started.text);
    expect(match).not.toBeNull();
    const childPid = Number(match![1]);
    expect(isAlive(childPid)).toBe(true);

    await client.stop();
    client = null;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(isAlive(childPid)).toBe(false);
  });
});
