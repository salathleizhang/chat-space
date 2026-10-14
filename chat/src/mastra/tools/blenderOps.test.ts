import { describe, expect, test } from "bun:test";
import { ChatServiceError } from "../../common/errors";
import { config } from "../../config";
import { join } from "node:path";
import { buildRequestContext } from "../../services/workflowRuns";
import {
  BLENDER_TOOLS,
  FRAME_ALL_SNIPPET,
  LIST_PLUGINS_SNIPPET,
  MARKER,
  BRIDGE_KILLING_CALLS,
  MAX_STEP_CHARS,
  SAFE_CLEAR_SNIPPET,
  blenderRunTool,
  mapWorkdirPath,
  parseMarker,
} from "./blenderOps";
import { BLENDER_ALLOWED_TOOLS } from "../../models/blenderMcp";

/**
 * 这一组钉的是**工具层的契约**，不是 Blender 的行为（那需要真的 Blender）。
 *
 * 最要紧的两条：
 *  1. agent 看得见的工具**恰好是白名单那 8 个**——多一个就是绕过 `blenderMcp.ts`
 *     的白名单闸门，尤其是三个生成器（重复付费）与三个资产市场（提示注入）。
 *  2. `blender-run` 的**小步闸门必须在 spawn 之前生效**——否则"拒绝一次超大调用"
 *     的代价反而是把一个 Blender 会话拉起来。
 */

const context = {
  requestContext: buildRequestContext({ projectSlug: "blender-test" }),
} as never;

describe("parseMarker", () => {
  test("从被包装过的返回文本里捞出标记行", () => {
    const text = `some log line\n${MARKER} {"framed": 2}\ntrailing noise`;
    expect(parseMarker(text)).toEqual({ framed: 2 });
  });

  test("标记在最后一行（没有换行结尾）也能捞到", () => {
    expect(parseMarker(`${MARKER} {"a":1}`)).toEqual({ a: 1 });
  });

  test("没有标记时返回 null（而不是抛错或返回空对象）", () => {
    expect(parseMarker("nothing here")).toBeNull();
    expect(parseMarker("")).toBeNull();
  });

  test("标记后面不是合法 JSON 时返回 null，交给调用方如实报错", () => {
    expect(parseMarker(`${MARKER} {broken`)).toBeNull();
  });

  test("多个标记时取最后一个（后面的是最新状态）", () => {
    const text = `${MARKER} {"n":1}\n${MARKER} {"n":2}`;
    expect(parseMarker(text)).toEqual({ n: 2 });
  });
});

describe("我们自己补的两个固定脚本", () => {
  test("都带回标记 —— 否则调用方无法把结果和日志分开", () => {
    expect(FRAME_ALL_SNIPPET).toContain(MARKER);
    expect(LIST_PLUGINS_SNIPPET).toContain(MARKER);
  });

  test("视口对准脚本直接写 region_3d，不走需要 context override 的 operator", () => {
    expect(FRAME_ALL_SNIPPET).toContain("region_3d");
    expect(FRAME_ALL_SNIPPET).not.toContain("bpy.ops.view3d");
  });

  test("插件清单脚本读的是 preferences.addons（启用状态的真源）", () => {
    expect(LIST_PLUGINS_SNIPPET).toContain("preferences.addons");
  });
});

describe("agent 看得见的 Blender 工具表", () => {
  test("恰好 8 个", () => {
    expect(Object.keys(BLENDER_TOOLS)).toHaveLength(8);
  });

  test("id 与我们定下的清单一一对应", () => {
    expect(Object.keys(BLENDER_TOOLS).sort()).toEqual([
      "blender-api",
      "blender-export",
      "blender-frame",
      "blender-look",
      "blender-plugins",
      "blender-run",
      "blender-scene",
      "blender-session",
    ]);
  });

  test("工具名与 MCP 白名单不重叠 —— 我们对外用的是自己的名字，不是转发", () => {
    // 传输入口只有 blenderMcp.ts 的白名单；工具层再包一层自己的命名，
    // 所以两份名单天然不该相等（相等说明有人在转发 MCP 工具）。
    const ours = new Set(Object.keys(BLENDER_TOOLS));
    const overlap = BLENDER_ALLOWED_TOOLS.filter((name) => ours.has(name));
    expect(overlap).toEqual([]);
  });

  test("每个工具都有非空描述（描述就是路由纪律的载体）", () => {
    for (const [id, tool] of Object.entries(BLENDER_TOOLS)) {
      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).length).toBeGreaterThan(80);
      void id;
    }
  });
});

describe("blender-run 的小步闸门", () => {  test(`超过 ${MAX_STEP_CHARS} 字符的代码被拒，且拒绝发生在拉起 Blender 之前`, async () => {
    let thrown: unknown = null;
    try {
      await blenderRunTool.execute!(
        { code: "x".repeat(MAX_STEP_CHARS + 1) } as never,
        context,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChatServiceError);
    expect((thrown as ChatServiceError).code).toBe("blender_step_too_large");
    // 关键的一半：这条错误必须来自"还没碰 Blender"的路径。
    // 如果它来自 spawn 之后的超时/连接失败，措辞会完全不同。
    expect((thrown as ChatServiceError).message).toContain("split it into multiple steps");
  });

  test("错误信息告诉模型怎么拆，而不是只说「太大了」", async () => {
    const error = (await blenderRunTool
      .execute!({ code: "y".repeat(MAX_STEP_CHARS + 1) } as never, context)
      .catch((thrown: unknown) => thrown)) as ChatServiceError;
    expect(error.message).toContain("build one part or add one modifier per step");
  });
});

/**
 * 这一条是**真机验证抓回来的**：社区版改过名，可执行文件是 `mcp-for-blender`，
 * 用改名前的老名字会得到
 * `An executable named 'blender-mcp' is not provided by package 'mcp-for-blender'`，
 * 而那个错误发生在 **MCP 握手里**，表面症状是"initialize 期间进程退出"——
 * 完全看不出是名字问题。所以把"启动参数里不能出现旧名字"钉死。
 */
describe("Blender MCP server 的启动参数", () => {
  test("默认用 uvx 拉起 mcp-for-blender，且不含改名前的老名字", () => {
    expect(config.blender.bin).toBe("uvx");
    expect([...config.blender.args]).toContain("mcp-for-blender");
    expect([...config.blender.args]).not.toContain("blender-mcp");
  });

  test("默认不启用 —— 没有 Blender 时不该让模型看见这 8 个工具", () => {
    expect(config.blender.enabled).toBe(false);
  });
});

/**
 * 路径映射 —— **Day-1 Docker 逼出来的那条缝**。
 *
 * 原设计是"Blender 写到 os.tmpdir()，chat/ 从同一个路径读回来"，前提是两者在同一个
 * 文件系统上。Blender 一进容器这个前提就没了，症状是「Blender 报告导出完成，但文件
 * 不存在」——看起来像 Blender 的错，实际是路径没映射。
 */
describe("共享目录的路径映射", () => {
  test("两头都配了就做前缀映射", () => {
    expect(mapWorkdirPath("/workspace/export-1/model.glb", "/workspace", "/Users/me/work")).toBe(
      join("/Users/me/work", "export-1/model.glb"),
    );
  });

  test("Blender 端的根带尾斜杠也能对（容器里挂载路径很容易多一个 /）", () => {
    expect(mapWorkdirPath("/workspace/a.glb", "/workspace/", "/local")).toBe("/local/a.glb");
  });

  test("没配 = 同一文件系统，路径原样返回（macOS 本地 Blender 那条路）", () => {
    expect(mapWorkdirPath("/tmp/x.glb", null, null)).toBe("/tmp/x.glb");
    expect(mapWorkdirPath("/tmp/x.glb", "/workspace", null)).toBe("/tmp/x.glb");
    expect(mapWorkdirPath("/tmp/x.glb", null, "/local")).toBe("/tmp/x.glb");
  });

  test("路径不在共享目录里就报错，而不是悄悄拼出一个错路径", () => {
    // 这一条重要：拼错的路径会变成"读不到文件"，让人去查 Blender；报错才指向真正的配置问题。
    const error = (() => {
      try {
        mapWorkdirPath("/tmp/x.glb", "/workspace", "/local");
        return null;
      } catch (thrown) {
        return thrown as ChatServiceError;
      }
    })();
    expect(error?.code).toBe("blender_workdir_mismatch");
  });

  test("前缀相同的兄弟目录不会被误判为在共享目录里", () => {
    // /workspace-other 不是 /workspace 的子路径。用裸 startsWith 会误判，
    // 于是把文件读到错误的地方。
    expect(() => mapWorkdirPath("/workspace-other/x.glb", "/workspace", "/local")).toThrow();
  });
});

/**
 * 会打死桥接自己的调用 —— 实测记录见 `BRIDGE_KILLING_CALLS` 的注释：
 * 跑一次 `read_factory_settings` 之后，`get_addon_status` 从 `native` 变成 `error`
 * 且**再也回不来**（只能重启 Blender/容器）。
 *
 * 这个闸门必须在**发出之前**生效：跑到一半才发现就晚了——addon 已经没了，
 * 连"报错"这条回程都没有。
 */
describe("拦住会打死桥接的调用", () => {
  test("read_factory_settings 被拒，且拒绝发生在调用 Blender 之前", async () => {
    const error = (await blenderRunTool
      .execute!(
        { code: "import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)", step: "清空" } as never,
        context,
      )
      .catch((thrown: unknown) => thrown)) as ChatServiceError;
    expect(error).toBeInstanceOf(ChatServiceError);
    expect(error.code).toBe("blender_call_would_kill_bridge");
  });

  test("报错里给出安全替代（删对象），而不是只说「不行」", async () => {
    const error = (await blenderRunTool
      .execute!(
        { code: "bpy.ops.wm.read_homefile(use_empty=True)" } as never,
        context,
      )
      .catch((thrown: unknown) => thrown)) as ChatServiceError;
    expect(error.message).toContain("bpy.data.objects.remove");
    expect(error.message).toContain("can never reconnect afterward");
  });

  test("安全替代本身不会被拦", async () => {
    // 它会真的去连 Blender（这里没有），所以只断言错误**不是**那个闸门。
    const thrown = (await blenderRunTool
      .execute!({ code: SAFE_CLEAR_SNIPPET, step: "清空" } as never, context)
      .catch((e: unknown) => e)) as ChatServiceError;
    expect(thrown.code).not.toBe("blender_call_would_kill_bridge");
  });

  test("闸门清单里的三个名字都覆盖（少一个就是个洞）", () => {
    for (const name of ["read_factory_settings", "read_homefile", "open_mainfile"]) {
      expect(BRIDGE_KILLING_CALLS as readonly string[]).toContain(name);
    }
  });
});

/**
 * 项目 slug 只能来自工具上下文，**不能是工具参数**。
 *
 * 2026-10-05 实测：我原先给了可选的 `projectSlug` 参数并让它覆盖上下文，
 * agent 看见就自己填了一个 —— `Failed: running blender-export tool: 项目「demo3」不存在`。
 * 真实项目是 `p-mushtjm9`，模型编的 `demo3` 把权威来源盖掉了，导出必然失败；
 * 而它前面的建模全对（1106 面的杯子 + 材质），整轮成果卡在最后一步。
 *
 * 这条测试是防止那个口子被重新打开。**它必须检查 schema，不能只检查实现**——
 * 参数只要出现在 schema 里，模型就会去填。
 */
describe("工具参数里不许出现 projectSlug", () => {
  test("8 个工具的 inputSchema 都不带 projectSlug", () => {
    const offenders: string[] = [];
    for (const [id, tool] of Object.entries(BLENDER_TOOLS)) {
      const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
      if (shape && Object.hasOwn(shape, "projectSlug")) offenders.push(id);
    }
    expect(offenders).toEqual([]);
  });
});
