import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import { glbTriangleCount } from "../../common/glb";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
} from "../../common/indexedFiles";
import { assetDir } from "../../common/libraryPaths";
import { RequestSidecarSchema, SlugSchema, type RequestSidecar } from "../../dto/library";
import { getBlenderMcp, addonStatusFromText } from "../../models/blenderMcp";
import { config } from "../../config";
import { getAssetStorage, writeJson, type AssetStorage } from "../../services/assetStorage";
import { startCustomTask } from "../../services/tasks";
import { publishGeneratedModel } from "../../services/modelPublishing";
import { requireProject } from "./projectTools";
import { requireCurrentProject } from "./requestContext";

/**
 * Blender 工具面（第 3 层）——agent 唯一看得见的 8 个工具。
 *
 * ## 这一层为什么存在（而不是把 MCP 的 36 个工具直接挂上去）
 *
 * 实测社区版 `mcp-for-blender` 暴露 **36 个工具，其中 30 个带一个 `user_prompt` 参数**
 * （`get_scene_info` 还是必填），而那个参数是喂给它的 `trajectory.py` 遥测的。直接挂上去
 * 的后果是：模型每次调用都要编一段"用户意图"、schema 被污染、**工具选择质量下降**——
 * 而工具选择正是本产品最在意的事。
 *
 * 所以 MCP 只当传输（`models/blenderMcp.ts`），对外只留这 8 个，描述是我们自己的路由纪律。
 *
 * ## 三条贯穿全文件的纪律
 *
 * **① 小步。** `execute_blender_code` 单次执行期间 Blender 的主线程被占住，**视口是冻的**
 * （`bpy.app.timers` 只在请求之间跑）。所以 `blender-run` 只该收"一步"，一次做完一整套
 * 会让盯着屏幕的人只看到画面卡住、然后啪一下出现成品。长度上限和耗时回报都是为了让
 * 这条纪律可执行，而不是建议。
 *
 * **② 每步回引擎事实。** "脚本没报错"不等于"模型建出来了"——bpy 最典型的失败是静默的
 * （成功退出但场景是空的、或者几何退化成 NaN 一团）。所以 `blender-run` 默认顺带取一次
 * `get_scene_info`，把对象数/面数/包围盒摆到模型眼前。判据要读引擎状态，不能读调用方的自述。
 *
 * **③ 导出走资产库，不走旁路。** `blender-export` 把 GLB 发布成本仓库既有的"新的一代"，
 * 于是它自动获得稳定 asset id、可被 `scene.json` 摆放、可被 `latestModel` 取到。
 * 这正是我们关掉 PolyHaven/Sketchfab 那套的理由——经 Blender 旁路进来的资产拿不到稳定 id。
 */

// ---------------------------------------------------------------------------
// 我们自己固定的小脚本（不是 LLM 写的）
// ---------------------------------------------------------------------------

/** 打印标记，便于从社区版包装过的返回文本里把它捞出来。 */
export const MARKER = "CS_RESULT";

/**
 * 视口对准整个场景。
 *
 * 社区版**没有**任何 frame/focus/view_all 命令（实测确认；官方版有
 * `jump_to_view3d_object_by_name`，社区版没有），而"模型建在视野外"意味着盯着屏幕的人
 * 什么都看不到——这是 A 路线（人要能实时看到）的硬需求，所以由我们自己补。
 *
 * 直接写 `region_3d`，不走 `bpy.ops.view3d.view_all`：后者要 context override，
 * 而前者对任何窗口布局都成立。
 */
export const FRAME_ALL_SNIPPET = `
import bpy, json
from mathutils import Vector
objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not objs:
    print("${MARKER} " + json.dumps({"framed": 0, "reason": "场景里没有网格"}))
else:
    lo = Vector((1e18, 1e18, 1e18)); hi = Vector((-1e18, -1e18, -1e18))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
    center = (lo + hi) / 2.0
    size = max((hi - lo).length, 0.2)
    framed = 0
    for window in bpy.context.window_manager.windows:
        screen = window.screen
        if not screen:
            continue
        for area in screen.areas:
            if area.type != 'VIEW_3D':
                continue
            r3d = area.spaces.active.region_3d if area.spaces.active else None
            if not r3d:
                continue
            r3d.view_location = center
            r3d.view_distance = size * 2.6
            area.tag_redraw()
            framed += 1
    print("${MARKER} " + json.dumps({"framed": framed, "size": round(size, 4)}))
`.trim();

/**
 * 列出已安装 / 已启用的插件。
 *
 * 两个 MCP 都**没有**这个能力，而"用社区插件"的前提正是模型知道有什么可用——
 * `bpy_api_lookup` 是按名字查的，模型不知道名字就不会去查它。
 */
export const LIST_PLUGINS_SNIPPET = `
import bpy, json
enabled = sorted(bpy.context.preferences.addons.keys())
print("${MARKER} " + json.dumps({
    "blender": bpy.app.version_string,
    "enabledAddons": enabled,
    "enabledCount": len(enabled),
}))
`.trim();

/**
 * 引擎事实：对象清单 + 面数 + 修改器 + 包围盒 + 退化检测。
 *
 * ## 为什么必须自己算，不能用社区版的 `get_scene_info`
 *
 * 实测它的返回（容器里 `get_scene_info` 的原始 JSON）：
 *
 *     顶层字段: name, object_count, objects, materials_count
 *     对象字段: name, type, location          ← **没有 faces、没有包围盒**
 *
 * 社区版为了压返回体积把它裁到只剩这些。而本仓库的纪律是「判据要读引擎状态」——
 * 面数为 0、坐标成 NaN 这类**静默失败**全靠这几个数字才能被发现，拿不到就等于没有判据。
 *
 * 这跟 `FRAME_ALL_SNIPPET` / `LIST_PLUGINS_SNIPPET` 是同一个套路：
 * **社区版没有的能力，用我们自己写的片段去补**。片段是我们写的，想返回什么就返回什么。
 *
 * 注意 `totalFaces` / `degenerate` 是要点：
 *   · `totalFaces === 0` 是 bpy 最典型的静默失败形态（脚本"成功"但场景是空的）
 *   · `degenerate` 把"0 面对象"和"含 NaN 坐标的对象"点名列出来，省得调用来回猜
 */
export const SCENE_FACTS_SNIPPET = `
import bpy, json, math
from mathutils import Vector
items = []
total_faces = 0
total_verts = 0
degenerate = []
lo = Vector((math.inf, math.inf, math.inf))
hi = Vector((-math.inf, -math.inf, -math.inf))
found = False
for o in sorted(bpy.context.scene.objects, key=lambda x: x.name):
    e = {"name": o.name, "type": o.type,
         "location": [round(c, 4) for c in o.location]}
    if o.type == 'MESH':
        faces = len(o.data.polygons)
        verts = len(o.data.vertices)
        e["faces"] = faces
        e["verts"] = verts
        e["modifiers"] = [m.type for m in o.modifiers]
        total_faces += faces
        total_verts += verts
        if faces == 0:
            degenerate.append(o.name)
        bad = 0
        for v in o.data.vertices:
            c = v.co
            if not (math.isfinite(c.x) and math.isfinite(c.y) and math.isfinite(c.z)):
                bad += 1
        if bad:
            e["nonFiniteVertices"] = bad
            degenerate.append(o.name)
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            if not (math.isfinite(w.x) and math.isfinite(w.y) and math.isfinite(w.z)):
                continue
            found = True
            for i in range(3):
                lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
    items.append(e)
bounds = None
if found:
    bounds = {"min": [round(c, 4) for c in lo],
              "max": [round(c, 4) for c in hi],
              "size": [round(hi[i] - lo[i], 4) for i in range(3)]}
print("${MARKER} " + json.dumps({
    "objects": items,
    "objectCount": len(items),
    "meshCount": sum(1 for i in items if i["type"] == 'MESH'),
    "totalFaces": total_faces,
    "totalVerts": total_verts,
    "bounds": bounds,
    "degenerate": degenerate,
}))
`.trim();

/**
 * 从社区版返回的文本里捞出我们的标记行。
 *
 * 社区版会把它自己的 stdout 包装一层（不同版本格式不同），所以**不要**假设返回就是纯 JSON：
 * 全文本扫一遍标记，找到就解析，找不到就返回 null 交给调用方如实报错。
 */
export function parseMarker(text: string): unknown | null {
  const index = text.lastIndexOf(`${MARKER} `);
  if (index < 0) return null;
  const rest = text.slice(index + MARKER.length + 1);
  const newline = rest.indexOf("\n");
  const line = (newline >= 0 ? rest.slice(0, newline) : rest).trim();
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 公共部分
// ---------------------------------------------------------------------------

/** 单步代码的长度上限。超了说明这不是"一步"——见模块文档纪律 ①。 */
export const MAX_STEP_CHARS = 6000;
/** 单步超过这个耗时就在返回里提示"下次拆小点"。 */
export const SLOW_STEP_MS = 12_000;

/**
 * **会打死 bridge 自己的 bpy 调用。**
 *
 * ## 实测（容器里逐项验过，不是推断）
 *
 * ```
 * ① 动之前:  get_addon_status → source=native     ← addon 活着
 * ② 执行:    bpy.ops.wm.read_factory_settings(use_empty=True)   ← 代码本身跑完了
 * ③ 之后:    get_addon_status → source=error      ← addon 死了，之后**永远**连不上
 * ```
 *
 * 原因是这些操作会**卸载并重载全部插件**——addon 的 socket 服务就在它自己的
 * `register()` 里起的，于是服务线程跟着没了。Blender 不会报错，我们的调用也"成功"了，
 * 但**桥接从此断掉**，直到重启 Blender/容器。
 *
 * 这是一个**单向陷阱**：agent 想"清空场景"，做了一件完全合理的事，代价是整条链路死掉；
 * 而症状（`source=error`、`Connection closed`）看起来像"容器坏了"。
 *
 * 所以这里拦住，并把**安全的做法**一起给它（见 `SAFE_CLEAR_SNIPPET`）：
 * 删对象不会碰插件，效果一样。
 */
export const BRIDGE_KILLING_CALLS = [
  "read_factory_settings",
  "read_homefile",
  "open_mainfile",
] as const;

/**
 * 安全的"清空场景"——**不碰插件**，因此不会打死桥接。
 *
 * 给 agent 的替代方案：想从空白开始就用这个，别用 `read_factory_settings`。
 */
export const SAFE_CLEAR_SNIPPET = [
  "import bpy",
  "for o in list(bpy.data.objects):",
  "    bpy.data.objects.remove(o, do_unlink=True)",
  "for c in (bpy.data.meshes, bpy.data.materials, bpy.data.curves):",
  "    for item in list(c):",
  "        if item.users == 0:",
  "            c.remove(item)",
].join("\n");

/**
 * 项目 slug **只从工具上下文取**，工具参数里没有这一项。
 *
 * ## 为什么（2026-10-05 实测踩到）
 *
 * 我原先给 8 个工具都加了可选的 `projectSlug` 参数，并且让"显式参数覆盖上下文"
 * （理由是"给测试与将来多项目场景留个口子"）。**结果是 agent 看见这个参数就自己填了一个**：
 *
 *     Failed: running blender-export tool: 项目「demo3」不存在
 *
 * 真实项目是 `p-mushtjm9`，`demo3` 是模型自己编的——它把**权威来源盖掉了**，
 * 于是导出必然失败。而它前面的建模全对（1106 面的杯子、材质也上了），
 * 整轮的成果卡在最后一步。
 *
 * 这也是本仓库的既有惯例：`place-object` 之类的工具**都不带 `projectSlug` 参数**，
 * 项目一律由 `requireCurrentProject(context)` 决定。模型没有机会填错。
 *
 * `blenderOps.test.ts` 里有一条会失败的测试钉住"这 8 个工具的 schema 里不许出现 projectSlug"。
 */
function projectOf(context: unknown): string {
  return requireCurrentProject(context as never);
}

interface StepOutcome {
  text: string;
  facts: unknown | null;
  factsUnavailable: string | null;
  ms: number;
}

/** 跑一段我们自己写的固定脚本，并要求它带回标记。 */
async function runOwnSnippet(snippet: string): Promise<unknown> {
  const mcp = getBlenderMcp();
  const result = await mcp.call("execute_blender_code", { code: snippet });
  const marker = parseMarker(result.text);
  if (marker === null) {
    throw new ChatServiceError(
      `Blender 没有返回预期的结果标记。原始返回：${result.text.slice(0, 400) || "（空）"}`,
      502,
      "blender_marker_missing",
    );
  }
  return marker;
}

// ---------------------------------------------------------------------------
// 1. 会话 / 健康检查
// ---------------------------------------------------------------------------

export const blenderSessionTool = createTool({
  id: "blender-session",
  description:
    "检查 Blender 会话是否可用，返回 Blender 版本、当前场景概况、以及 Blender 的**连接状态**。在任何其它 blender-* 工具之前或用户问「Blender 连上了吗」时用它。\n\n" +
    "注意区分两件事：**MCP server 起来了**不代表 **Blender 连上了**——社区版的 server 在没有 Blender 时也能启动（它只会往日志里写一句连接被拒）。所以这里问的是 Blender 本身（get_addon_status），不是进程存活。\n\n" +
    "**什么时候不要用它**：不要为了「确认一下」而在每一步建模之间反复调用——blender-run 已经会带回场景事实。",
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    projectOf(context);
    const mcp = getBlenderMcp();
    try {
      const result = await mcp.call("get_addon_status", {}, { timeoutMs: 30_000 });
      /*
        ⚠️ 这里**不能**用「调用没抛错」当「连上了」。

        真机实测：Blender 没跑时 `get_addon_status` 返回的是**成功结果**，`isError` 是
        false，失败写在文本里——`Error checking addon status: Could not connect to
        Blender...`。照 isError 判断会得到 `connected: true` 的假阳性，而这恰好是
        agent 最需要准确的那个信号。判据见 `addonStatusFromText`。
      */
      const status = addonStatusFromText(result.text);
      if (!status.connected) {
        return {
          connected: false,
          error: status.raw.slice(0, 400),
          diagnostics: mcp.diagnostics,
          hint:
            "Blender 进程在，但没有 addon 在监听那个端口。请在 Blender 里启用并启动" +
            "ChatSpace 对应的 MCP 插件（3D 视口侧栏，N 键）。",
        };
      }
      return {
        connected: true,
        addon: result.json,
        raw: result.json === null ? result.text.slice(0, 500) : undefined,
      };
    } catch (error) {
      return {
        connected: false,
        error: toErrorMessage(error),
        diagnostics: mcp.diagnostics,
        hint:
          "MCP server 没能和 Blender 建立连接。先确认 Blender 在跑、插件已启动、" +
          "以及 BLENDER_HOST/BLENDER_PORT 指向的是 Blender 所在的那台机器。",
      };
    }
  },
});

// ---------------------------------------------------------------------------
// 2. 场景事实
// ---------------------------------------------------------------------------

export const blenderSceneTool = createTool({
  id: "blender-scene",
  description:
    "读取当前 Blender 场景的**引擎事实**：每个对象的类型/面数/修改器/位置，以及整个场景的包围盒。可选传 objectName 只看一个对象的细节。\n\n" +
    "**这是判据，不是描述。**「脚本没报错」不等于「模型建出来了」——bpy 最典型的失败是静默的：脚本成功退出但场景是空的、或者几何退化成 NaN。要判断上一步到底有没有产生东西，看这里的对象数与面数。\n\n" +
    "**什么时候不要用它**：blender-run 默认已经顺带返回一次场景事实，所以「刚跑完一步想看结果」不需要单独调它；只在「隔了几步之后要重新确认状态」或「要看某个具体对象」时单独调用。",
  inputSchema: z.object({
    objectName: z.string().min(1).optional(),
  }),
  execute: async (input, context) => {
    projectOf(context);
    const mcp = getBlenderMcp();
    if (input.objectName) {
      const result = await mcp.call("get_object_info", { object_name: input.objectName });
      return { object: result.json, raw: result.json === null ? result.text : undefined };
    }
    // 同样用我们自己的片段：社区版那份没有面数（见 SCENE_FACTS_SNIPPET 的说明）。
    return { scene: await runOwnSnippet(SCENE_FACTS_SNIPPET) };
  },
});

// ---------------------------------------------------------------------------
// 3. 执行一步
// ---------------------------------------------------------------------------

export const blenderRunTool = createTool({
  id: "blender-run",
  description:
    "在 Blender 里执行**一步** bpy 代码（`bpy`、`bmesh`、`mathutils` 已在作用域内），返回代码的输出 + 执行后的场景事实。这是建模主力。\n\n" +
    "**必须小步。** 单次执行期间 Blender 的主线程被占住，**用户的视口是冻住的**（画面只在两次调用之间刷新）。一次提交一整套建模会让盯着屏幕的人只看到画面卡住、然后啪一下出现成品——那正是这个功能要避免的。正确节奏是：建一个部件 → 看事实 → 加一个修改器 → 看事实 → 布尔 → 看事实。\n\n" +
    "**每步都要看返回的 facts**（对象数/面数/包围盒）。面数是 0 或包围盒退化说明这一步静默失败了，不要继续往上堆。\n\n" +
    "`frame` 默认 true：每步之后把视口对准场景，这样用户能看到刚才那一步干了什么。想固定机位对比前后变化时传 false。\n\n" +
    "**什么时候不要用它**：不要用它做 Blender 之外的事。导出用 blender-export；查 API 或插件签名用 blender-api（猜 operator 参数名会浪费好几轮）；看已装插件用 blender-plugins。\n\n" +
    "⚠️ **不要用 `bpy.ops.wm.read_factory_settings()` 来清空场景**——那个调用会卸载并重载全部插件，" +
    "而 ChatSpace 的 socket 服务挂在插件上，**一跑桥接就断了、之后再也连不上**（实测过的单向陷阱）。" +
    "想从空白开始就删对象：`for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)`。" +
    "这一条在工具层被直接拦下，所以你会收到一条报错而不是把链路打死。",
  inputSchema: z.object({
    /** 一段 bpy 代码。作用域里已有 bpy / bmesh / math / Matrix / Vector。 */
    code: z.string().min(1),
    /** 这一步在干什么（一句话，给用户看的状态文字；不参与逻辑） */
    step: z.string().max(200).optional(),
    /** 跑完是否把视口对准场景（默认 true） */
    frame: z.boolean().optional(),
  }),
  execute: async (input, context) => {
    projectOf(context);
    // 拦住会打死桥接自己的调用（见 BRIDGE_KILLING_CALLS 的实测记录）。
    // **必须在发出之前拦**：跑到一半才发现就晚了——addon 已经没了，连"报错"这条回程都没有。
    const killer = BRIDGE_KILLING_CALLS.find((name) => input.code.includes(name));
    if (killer) {
      throw new ChatServiceError(
        `这段代码里有 \`${killer}\`，它会**卸载并重载全部插件**——而 ChatSpace 的 socket 服务` +
          `就挂在插件上，所以这一跑桥接就断了，之后**再也连不上**，只能重启 Blender/容器。` +
          `Blender 不会报错，看起来像"容器坏了"，这是实测过的单向陷阱。\n\n` +
          `想从空白场景开始请改用删对象（效果一样、不碰插件）：\n\n${SAFE_CLEAR_SNIPPET}`,
        400,
        "blender_call_would_kill_bridge",
      );
    }

    if (input.code.length > MAX_STEP_CHARS) {      throw new ChatServiceError(
        `这一步的代码有 ${input.code.length} 字符，超过单步上限 ${MAX_STEP_CHARS}。` +
          `这基本一定是在一次调用里做完了整套建模——请拆成多步：每一步建一个部件或加一个修改器，` +
          `每步之后看返回的 facts 再决定下一步。用户的视口在单次执行期间是冻住的，拆开才看得到过程。`,
        400,
        "blender_step_too_large",
      );
    }

    const mcp = getBlenderMcp();
    const started = Date.now();
    const run = await mcp.call("execute_blender_code", { code: input.code });
    const ms = Date.now() - started;

    // 纪律 ②：默认顺带取一次引擎事实。**用我们自己的片段，不用社区版的 get_scene_info**
    // ——后者只返回 name/type/location，没有面数（见 SCENE_FACTS_SNIPPET 的说明）。
    // 失败不致命（不该因为"读不到状态"把一次成功的建模判死），但必须如实说"读不到"。
    let facts: unknown | null = null;
    let factsUnavailable: string | null = null;
    try {
      facts = await runOwnSnippet(SCENE_FACTS_SNIPPET);
    } catch (error) {
      factsUnavailable = toErrorMessage(error);
    }

    // 纪律：帧率是"看得见"的前提。对准失败同样不致命，但要说。
    let framed: unknown | null = null;
    let frameError: string | null = null;
    if (input.frame !== false) {
      try {
        framed = await runOwnSnippet(FRAME_ALL_SNIPPET);
      } catch (error) {
        frameError = toErrorMessage(error);
      }
    }

    const out: Record<string, unknown> = {
      step: input.step,
      output: run.text.slice(0, 4000),
      ms,
      facts,
    };
    if (factsUnavailable) out.factsUnavailable = factsUnavailable;
    if (framed) out.framed = framed;
    if (frameError) out.frameError = frameError;
    if (ms > SLOW_STEP_MS) {
      out.warning =
        `这一步跑了 ${(ms / 1000).toFixed(1)} 秒，期间用户的视口是冻住的。` +
        `下一步请拆得更小。`;
    }
    // 面数为 0 是最典型的静默失败，直接点出来，别让模型自己从一堆 JSON 里找。
    const total = (facts as { totalFaces?: number } | null)?.totalFaces;
    if (typeof total === "number" && total === 0) {
      out.warning =
        "执行后场景里**一个面都没有**——这一步多半静默失败了（对象没建出来、或者布尔把它减没了）。" +
        "先修这一步，不要在空场景上继续。";
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// 4. API / 插件签名查询
// ---------------------------------------------------------------------------

export const blenderApiTool = createTool({
  id: "blender-api",
  description:
    "查 Blender 的 **RNA/API 真实签名**：类型、属性、函数、以及 operator 的参数（名字、类型、是否必填、枚举取值、默认值）。\n\n" +
    "两种用法：① `query` 查类型/属性/方法/operator，例如 `bpy.ops.mesh.primitive_cube_add`、`Object.ray_cast`、`ShaderNodeTexSky.sky_type`；② `nodeType` 看某个几何节点类型的输入输出。\n\n" +
    "**这是省轮次的关键工具**：查的是**活着的** RNA 注册表，所以它同时能给出**你安装的社区插件**里 operator 的真实签名（插件注册的 operator 就在 `bpy.ops` 里）。凭记忆猜参数名在 Blender 里代价很高——一次报错就是一轮往返。\n\n" +
    "**什么时候用它**：不确定某个 operator 的参数名、枚举取值，或者要用某个插件前想确认它的接口；以及 `blender-run` 报「operator not found / context is incorrect」之后。",
  inputSchema: z.object({
    /** 类型/属性/方法/operator 路径，如 bpy.ops.mesh.primitive_cube_add */
    query: z.string().min(1).optional(),
    /** 几何节点类型的 bl_idname */
    nodeType: z.string().min(1).optional(),
  }),
  execute: async (input, context) => {
    projectOf(context);
    if (!input.query && !input.nodeType) {
      throw new ChatServiceError("query 与 nodeType 至少给一个", 400, "blender_api_missing_query");
    }
    const mcp = getBlenderMcp();
    if (input.nodeType) {
      const result = await mcp.call("describe_node_type", { bl_idname: input.nodeType });
      return { nodeType: result.json, raw: result.json === null ? result.text : undefined };
    }
    const result = await mcp.call("bpy_api_lookup", { query: input.query });
    return { api: result.json, raw: result.json === null ? result.text : undefined };
  },
});

// ---------------------------------------------------------------------------
// 5. 看
// ---------------------------------------------------------------------------

export const blenderLookTool = createTool({
  id: "blender-look",
  description:
    "抓一张**当前视口**的截图（PNG），让 agent 自己也能看到场景。\n\n" +
    "注意它的定位：**这是给 agent 自检用的，不是给用户看的**。用户看到的是实时推流（本地是 Blender 自己的窗口，云端是 KasmVNC/Selkies）。所以别把它当成「给用户展示进度」的手段。\n\n" +
    "**什么时候用它**：用户明确要求检查、或者用户对已产出的东西提出疑问、或者你要确认某个几何特征（破洞、穿模、比例）单看面数判断不了。**不要**每步都截图——它很慢，而且大部分问题看 blender-run 返回的引擎事实就够了。",
  inputSchema: z.object({
    /** 图片长边上限（像素），默认 800；越大越慢 */
    maxSize: z.number().int().positive().max(2048).optional(),
  }),
  execute: async (input, context) => {
    projectOf(context);
    const mcp = getBlenderMcp();
    const result = await mcp.call(
      "get_viewport_screenshot",
      input.maxSize ? { max_size: input.maxSize } : {},
      { timeoutMs: 90_000 },
    );
    // 社区版把 PNG 放在 MCP 的 image content 里，wrapResult 只保留了 text 段——
    // 所以这里如实回报"拿到了什么"，而不是假装有图。需要图片字节时走
    // `callRaw`（见 models/blenderMcp.ts 的说明）。
    return {
      text: result.text.slice(0, 500),
      ms: result.ms,
      note:
        "如果这里没有图片数据，说明社区版把 PNG 放在 MCP 的 image content 段里、" +
        "而本层只解析了 text 段。需要真正拿到 PNG 时补一条 raw content 通路。",
    };
  },
});

// ---------------------------------------------------------------------------
// 6. 视口对准（我们自己补的）
// ---------------------------------------------------------------------------

export const blenderFrameTool = createTool({
  id: "blender-frame",
  description:
    "把 Blender 的 3D 视口对准当前场景（或某个对象），让正在看的用户能看见刚做出来的东西。\n\n" +
    "**这是这个功能能不能「看得见」的关键。** 物体建在原点之外、或者尺寸与当前视野差一个数量级时，用户盯着屏幕只会看到一片空白，会以为 agent 什么都没做。\n\n" +
    "blender-run 默认已经会做这件事（frame=true），所以通常在「agent 自己挪了相机/改了视角」或「想固定一个机位看整体」时才单独调用它。",
  inputSchema: z.object({}),
  execute: async (input, context) => {
    projectOf(context);
    return { framed: await runOwnSnippet(FRAME_ALL_SNIPPET) };
  },
});

// ---------------------------------------------------------------------------
// 7. 已装插件清单（我们自己补的）
// ---------------------------------------------------------------------------

export const blenderPluginsTool = createTool({
  id: "blender-plugins",
  description:
    "列出**当前 Blender 实例里已启用**的插件。\n\n" +
    "两个 MCP 都没有这个能力，而它是用社区插件的前提：查插件 operator 签名要靠 `blender-api`，而那个工具是**按名字查**的——你不知道插件叫什么，就不会去查它。所以要用某个插件（HardOps、Boxcutter、Node Wrangler…）之前，先在这里确认它确实装了并启用了。\n\n" +
    "**注意**：云端容器里的 Blender 是干净的，只有镜像里打进去的插件。这里返回的清单反映的是**Blender 所在那台机器**，不是你这台 Mac。",
  inputSchema: z.object({}),
  execute: async (input, context) => {
    projectOf(context);
    return { plugins: await runOwnSnippet(LIST_PLUGINS_SNIPPET) };
  },
});

// ---------------------------------------------------------------------------
// 8. 导出 → 发布进资产库
// ---------------------------------------------------------------------------

export const BlenderExportInputSchema = z.object({
  
  /** 资产 slug（写进 `projects/<project>/assets/<slug>/`） */
  assetSlug: SlugSchema,
  /** 资产显示名 */
  name: z.string().min(1).optional(),
  intent: z.string().min(1).optional(),
  /** 只导出这些对象；不传则导出整个场景 */
  objectNames: z.array(z.string().min(1)).optional(),
});
export type BlenderExportInput = z.infer<typeof BlenderExportInputSchema>;

export interface BlenderExportResult {
  glbPath: string;
  sidecarPath: string;
  index: number;
  bytes: number;
  faces: number | null;
  blenderVersion: string | null;
}

/**
 * 把「Blender 看到的路径」映射成「chat/ 能读到的路径」。
 *
 * ## 为什么需要它（这是 Day-1 Docker 逼出来的）
 *
 * 原先的设计是「Blender 写到 `os.tmpdir()`，chat/ 从同一个路径读回来」——那个前提是
 * **Blender 与 chat/ 在同一个文件系统上**。Blender 一进容器，这个前提立刻不成立：
 * 容器里的 `/tmp` 和宿主机上的 `/tmp` 是两个地方。原写法会得到一句
 * 「Blender 报告导出完成，但文件不存在」，而且看起来像 Blender 的错。
 *
 * 规则很简单：两端都配了共享目录就做前缀映射；没配就按同一文件系统处理。
 * 上云（容器不在这台机器上）时**只换这一个函数**——从"读本地文件"变成"从沙箱取回字节"。
 */
export function resolveBlenderOutputPath(blenderPath: string): string {
  return mapWorkdirPath(blenderPath, config.blender.workDir, config.blender.localWorkDir);
}

/**
 * 映射的**纯函数**部分 —— `config` 是 `as const` 冻结的，测试改不动它，所以把逻辑抽出来。
 *
 * 两个 root 有一个为空 = 按同一文件系统处理（macOS 本地 Blender，或 Blender 与 chat/ 同机）。
 * 只配一半时也走这条路，让调用方在报错里同时看到两个路径 —— 那比在映射层抛一个
 * 语焉不详的错有用得多。
 */
export function mapWorkdirPath(
  blenderPath: string,
  blenderRoot: string | null,
  localRoot: string | null,
): string {
  if (!blenderRoot || !localRoot) return blenderPath;

  const normalizedRoot = blenderRoot.replace(/\/+$/, "");
  if (blenderPath !== normalizedRoot && !blenderPath.startsWith(`${normalizedRoot}/`)) {
    throw new ChatServiceError(
      `Blender 写出的路径 \`${blenderPath}\` 不在共享目录 \`${blenderRoot}\` 里面，` +
        `无法映射到宿主机。请确认 BLENDER_WORKDIR 与容器里挂载的目录一致。`,
      500,
      "blender_workdir_mismatch",
    );
  }
  return join(localRoot, blenderPath.slice(normalizedRoot.length));
}

/** 导出用的临时目录：配了共享目录就用它（两端都看得见），否则用本机 tmpdir。 */
function blenderScratchDir(): { blenderPath: string; localPath: string } {
  const shared = config.blender.workDir;
  if (shared) {
    const name = `export-${randomUUID()}`;
    const blenderPath = join(shared, name);
    return { blenderPath, localPath: resolveBlenderOutputPath(blenderPath) };
  }
  const local = join(tmpdir(), `chatspace-blender-${randomUUID()}`);
  return { blenderPath: local, localPath: local };
}

/**
 * 导出当前 Blender 场景为 GLB 并发布成资产的**新的一代**。
 *
 * 三条刻意的设计：
 *
 * 1. **Blender 只往共享目录写**，字节由本层读回来后写进资产库。这样"本地"和
 *    "云端"只差 `resolveBlenderOutputPath` 一个函数——云端时把它换成"从沙箱取回字节"，
 *    其余（索引、侧写、发布、校验）一个字都不用改。
 * 2. **新索引、绝不覆盖**（`nextIndex` + `formatIndexedName`）：与 cadOps 同一套约定，
 *    改参重跑得到的是新的一代，旧产物留着可回溯。
 * 3. **发布前验产物**：GLB 容器级解析出面数，0 或读不出来都判失败并如实报错。
 *    "Blender 说导出了"不是判据。
 */
export async function runBlenderExport(
  storage: AssetStorage,
  projectSlug: string,
  input: Omit<BlenderExportInput, "projectSlug">,
): Promise<BlenderExportResult> {
  await requireProject(storage, projectSlug);

  const mcp = getBlenderMcp();
  const version = await mcp.call("get_addon_status", {}, { timeoutMs: 30_000 }).catch(() => null);

  const scratch = blenderScratchDir();
  await mkdir(scratch.localPath, { recursive: true });
  const exported = join(scratch.blenderPath, "model.glb");

  try {
    const result = await mcp.call(
      "export_scene",
      {
        filepath: exported,
        format: "glb",
        ...(input.objectNames ? { object_names: input.objectNames } : {}),
      },
      { timeoutMs: 180_000 },
    );

    // 读的是**映射之后**的路径 —— Blender 写的那个路径 chat/ 可能根本看不见。
    const file = Bun.file(resolveBlenderOutputPath(exported));
    if (!(await file.exists())) {
      throw new ChatServiceError(
        `Blender 报告导出完成，但从 chat/ 这边读不到文件。\n` +
          `Blender 写的路径：${exported}\n` +
          `chat/ 读的路径：${resolveBlenderOutputPath(exported)}\n` +
          `两个进程在同一个文件系统上吗？配了 BLENDER_WORKDIR 就必须同时配 ` +
          `CHATSPACE_BLENDER_WORKDIR（容器里则是把同一个目录挂给两边）。\n` +
          `Blender 返回：${result.text.slice(0, 300) || "（空）"}`,
        502,
        "blender_export_missing_file",
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength < 1024) {
      throw new ChatServiceError(
        `导出的 GLB 只有 ${bytes.byteLength} 字节，几乎肯定是坏的（导出中途失败）`,
        502,
        "blender_export_truncated",
      );
    }
    const faces = glbTriangleCount(bytes);
    if (faces === 0) {
      throw new ChatServiceError(
        "导出的 GLB 是 0 个三角面——场景里没有可导出的几何，或者最后一步静默失败了。" +
          "先用 blender-scene 确认对象数与面数。",
        422,
        "blender_export_empty",
      );
    }

    const dir = assetDir(projectSlug, input.assetSlug);
    const index = nextIndex(await storage.list(dir));
    const glbPath = `${dir}/${formatIndexedName(index, input.assetSlug, "glb")}`;
    const sidecarPath = `${dir}/${formatRequestSidecarName(index, input.assetSlug)}`;

    const now = () => new Date().toISOString();
    const sidecar: RequestSidecar = {
      schemaVersion: 1,
      index,
      slug: input.assetSlug,
      provider: "blender",
      // 版本进侧写：Blender 大版本之间 bpy 与导出器行为会变，没有这一条以后全是悬案。
      model: `blender-${(version?.json as { blender_version?: string } | null)?.blender_version ?? "unknown"}`,
      params: {
        ...(input.objectNames ? { objectNames: input.objectNames } : {}),
        ...(input.name ? { name: input.name } : {}),
      },
      status: "running",
      outputs: [],
      createdAt: now(),
      updatedAt: now(),
    };
    const saveSidecar = () =>
      writeJson(storage, sidecarPath, RequestSidecarSchema, {
        ...sidecar,
        updatedAt: now(),
      });
    await saveSidecar();

    try {
      await storage.writeBytes(glbPath, bytes);
      sidecar.outputs.push({ path: glbPath });
      sidecar.status = "succeeded";
      await saveSidecar();
      await publishGeneratedModel(storage, projectSlug, {
        slug: input.assetSlug,
        name: input.name ?? input.assetSlug,
        intent: input.intent ?? `Blender 建模：${input.name ?? input.assetSlug}`,
        sourceImages: [],
      }, { files: [glbPath] });
    } catch (error) {
      sidecar.status = "failed";
      sidecar.error = toErrorMessage(error);
      await saveSidecar();
      throw error;
    }

    return {
      glbPath,
      sidecarPath,
      index,
      bytes: bytes.byteLength,
      faces,
      blenderVersion:
        (version?.json as { blender_version?: string } | null)?.blender_version ?? null,
    };
  } finally {
    // 临时目录只用来中转字节；失败也要清掉，否则每次失败都留一个 GLB。
    await rm(scratch.localPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const blenderExportTool = createTool({
  id: "blender-export",
  description:
    "把当前 Blender 场景导出成 GLB，并**发布进本工程的资产库**（成为该资产的新的一代）。这是「用 Blender 建完 → 拿到模型」的最后一步。\n\n" +
    "发布之后这个模型就有了稳定 asset id，因此：会出现在模型列表里、可以被 place-object 摆放、视口会自动加载、缩略图与检查图都能生成。\n\n" +
    "**导出前会自动应用修改器**（未应用的修改器不会进 GLB）。**产物会被校验**：0 个三角面或文件被截断都会判失败并如实报错——所以如果这一步报错，先去 blender-scene 看对象数和面数，不要在空场景上反复重试。\n\n" +
    "**不会覆盖**旧产物：每次导出都是新的一代（索引递增），旧模型保留可回溯。所以「再改一版」是安全的。\n\n" +
    "⚠️ **这是异步的**：调用立刻返回一个后台任务，导出在后台跑完，**工作台会自动刷新并把新模型显示出来**（不用你或用户手动刷新页面）。所以**完成后不要重复调用它去「确认」**——重复调用会发布出多余的一代。\n\n" +
    "**什么时候不要用它**：只想要一张图用 blender-look；还没建完不要急着导出。",
  inputSchema: BlenderExportInputSchema,
  execute: async (input, context) => {
    const projectSlug = projectOf(context);
    /*
      **必须走后台任务，不能同步发布。** 实测（2026-10-05，用户报"导出成功但场景里没有"）：
      同步发布时资产确实写进了库（`assets/<slug>/asset.json` 都在），但 **app 不会重新拉列表**
      ——`refreshKey` 的触发点只有 plan 更新 / 模型导入 / 资产删除三种，
      "某个工具同步写了一个资产"不在其中，于是用户得手动刷新页面才看得见。

      而 `useTaskPolling` 里那条判据是（`AppPolling.ts:192`）：

          if (task.status === "running" || reportedTasksRef.current.has(task.id)) continue;
          bumpRefresh();

      也就是**任何非 running 且尚未报告过的任务都会触发一次刷新**。所以注册一个任务，
      app 会在 1 秒内看到它完成、自动刷新、模型就出现在列表里——这正是
      `retopologize` / `start-3d-batch` 走的路，也是本仓库对"会产出资产的操作"的标准形状。

      代价是工具不再当场回结果，改为"起任务 + 完成后由工作台通知"——
      与其它生成器的 UX 一致，不再是一个特例。
    */
    const task = startCustomTask(
      "blender",
      projectSlug,
      `Blender 导出：${input.name ?? input.assetSlug}`,
      () =>
        runBlenderExport(getAssetStorage(), projectSlug, {
          assetSlug: input.assetSlug,
          ...(input.name ? { name: input.name } : {}),
          ...(input.intent ? { intent: input.intent } : {}),
          ...(input.objectNames ? { objectNames: input.objectNames } : {}),
        }),
    );
    return {
      task: { id: task.id, subject: task.subject, status: task.status },
      note:
        "导出已在后台开始，完成后工作台会自动刷新模型列表并把它显示出来。" +
        "你不用手动刷新页面；也不要重复调用这个工具等结果。",
    };
  },
});

/** agent 唯一看得见的 8 个 Blender 工具（与 `agents/creator.ts` 的挂载清单一一对应）。 */
export const BLENDER_TOOLS = {
  "blender-session": blenderSessionTool,
  "blender-scene": blenderSceneTool,
  "blender-run": blenderRunTool,
  "blender-api": blenderApiTool,
  "blender-look": blenderLookTool,
  "blender-frame": blenderFrameTool,
  "blender-plugins": blenderPluginsTool,
  "blender-export": blenderExportTool,
} as const;
