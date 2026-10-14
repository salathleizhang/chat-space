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
import { BlenderCloudClient, assertBlenderProject } from "../../models/blenderCloud";
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
    print("${MARKER} " + json.dumps({"framed": 0, "reason": "no mesh in the scene"}))
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
  const projectSlug = requireCurrentProject(context as never);
  assertBlenderProject(projectSlug);
  return projectSlug;
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
      `Blender did not return the expected result marker. Raw response: ${result.text.slice(0, 400) || "(empty)"}`,
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
    "Check whether the Blender session is usable, returning the Blender version, an overview of the current scene, and Blender's **connection status**. Use it before any other blender-* tool, or when the user asks \"is Blender connected\".\n\n" +
    "Be careful to distinguish two things: **the MCP server being up** does not mean **Blender is connected** — the community server can start without Blender (it only writes a line in the log saying the connection was refused). So what is asked about here is Blender itself (get_addon_status), not process liveness.\n\n" +
    "**When not to use it**: do not call it repeatedly between every modeling step just to \"make sure\" — blender-run already brings back the scene facts.",
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
            "The Blender process is there, but no addon is listening on that port. In Blender, enable and start " +
            "the MCP addon for ChatSpace (3D viewport sidebar, N key).",
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
          "The MCP server could not establish a connection to Blender. First confirm Blender is running, the addon has been started, " +
          "and BLENDER_HOST/BLENDER_PORT point to the machine where Blender is running.",
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
    "Read the **engine facts** of the current Blender scene: each object's type/face count/modifiers/location, plus the bounding box of the whole scene. Optionally pass objectName to see the details of just one object.\n\n" +
    "**This is evidence, not a description.** \"The script did not error\" does not mean \"the model was built\" — bpy's most typical failures are silent: the script exits successfully but the scene is empty, or the geometry degenerates into NaN. To tell whether the previous step actually produced anything, look at the object count and face count here.\n\n" +
    "**When not to use it**: blender-run already returns the scene facts by default, so \"I just ran a step and want to see the result\" does not need a separate call; call it separately only when \"re-confirming the state after several steps\" or \"wanting to look at one specific object\".",
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
    "Execute **one step** of bpy code in Blender (`bpy`, `bmesh`, `mathutils` are already in scope), returning the code's output + the scene facts after execution. This is the main modeling workhorse.\n\n" +
    "**It must be small steps.** During a single execution Blender's main thread is occupied, so **the user's viewport is frozen** (the picture only refreshes between two calls). Submitting a whole modeling sequence at once makes the person watching the screen see the picture freeze and then the finished product pop into existence — exactly what this feature is meant to avoid. The right rhythm is: build one part → look at the facts → add one modifier → look at the facts → boolean → look at the facts.\n\n" +
    "**Look at the returned facts after every step** (object count/face count/bounding box). A face count of 0 or a degenerate bounding box means this step failed silently; do not keep piling more on top.\n\n" +
    "`frame` defaults to true: after each step the viewport is aimed at the scene, so the user can see what that step just did. Pass false when you want a fixed camera position to compare before and after.\n\n" +
    "**When not to use it**: do not use it for anything outside Blender. Use blender-export to export; use blender-api to look up API or addon signatures (guessing operator parameter names wastes several turns); use blender-plugins to see installed addons.\n\n" +
    "⚠️ **Do not use `bpy.ops.wm.read_factory_settings()` to clear the scene** — that call unloads and reloads all addons, " +
    "and ChatSpace's socket service is attached to the addon, so **the bridge dies the moment it runs and can never reconnect afterward** (a one-way trap confirmed by real testing). " +
    "To start from a blank scene, delete the objects instead: `for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)`. " +
    "The tool layer blocks this one outright, so you will get an error instead of killing the link.",
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
        `This code contains \`${killer}\`, which **unloads and reloads all addons** — and ChatSpace's socket service` +
          ` is attached to the addon, so the bridge dies the moment it runs and can never reconnect afterward; the only fix is restarting Blender/the container.` +
          ` Blender does not report an error, so it looks like "the container is broken" — a one-way trap confirmed by real testing.\n\n` +
          `To start from a blank scene, use object deletion instead (same effect, does not touch addons):\n\n${SAFE_CLEAR_SNIPPET}`,
        400,
        "blender_call_would_kill_bridge",
      );
    }

    if (input.code.length > MAX_STEP_CHARS) {      throw new ChatServiceError(
        `This step's code is ${input.code.length} characters, over the single-step limit of ${MAX_STEP_CHARS}.` +
          ` This almost certainly means the whole modeling sequence was done in one call — split it into multiple steps: build one part or add one modifier per step,` +
          ` and look at the returned facts after each step before deciding the next one. The user's viewport is frozen during a single execution, so only by splitting it can the process be seen.`,
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
        `This step ran for ${(ms / 1000).toFixed(1)} seconds, during which the user's viewport was frozen.` +
        ` Please split the next step smaller.`;
    }
    // 面数为 0 是最典型的静默失败，直接点出来，别让模型自己从一堆 JSON 里找。
    const total = (facts as { totalFaces?: number } | null)?.totalFaces;
    if (typeof total === "number" && total === 0) {
      out.warning =
        "After execution the scene has **not a single face** — this step most likely failed silently (the object was not created, or a boolean subtracted it away)." +
        " Fix this step first; do not continue building on an empty scene.";
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
    "Look up Blender's **real RNA/API signatures**: types, properties, functions, and operator parameters (name, type, whether required, enum values, default).\n\n" +
    "Two usages: ① `query` looks up a type/property/method/operator, for example `bpy.ops.mesh.primitive_cube_add`, `Object.ray_cast`, `ShaderNodeTexSky.sky_type`; ② `nodeType` shows the inputs and outputs of a geometry node type.\n\n" +
    "**This is the key tool for saving turns**: it queries the **live** RNA registry, so it can also give the real signatures of operators in **the community addons you installed** (operators registered by addons live in `bpy.ops`). Guessing parameter names from memory is very expensive in Blender — one error is one round trip.\n\n" +
    "**When to use it**: when you are unsure of an operator's parameter names or enum values, or want to confirm an addon's interface before using it; and after `blender-run` reports \"operator not found / context is incorrect\".",
  inputSchema: z.object({
    /** 类型/属性/方法/operator 路径，如 bpy.ops.mesh.primitive_cube_add */
    query: z.string().min(1).optional(),
    /** 几何节点类型的 bl_idname */
    nodeType: z.string().min(1).optional(),
  }),
  execute: async (input, context) => {
    projectOf(context);
    if (!input.query && !input.nodeType) {
      throw new ChatServiceError("Provide at least one of query and nodeType", 400, "blender_api_missing_query");
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
    "Capture a screenshot (PNG) of the **current viewport**, so the agent itself can see the scene too.\n\n" +
    "Note what it is for: **this is for the agent's self-check, not for the user**. What the user sees is the live stream (locally Blender's own window; in the cloud KasmVNC/Selkies). So do not treat it as a way to \"show the user progress\".\n\n" +
    "**When to use it**: the user explicitly asks for a check, or the user questions something already produced, or you need to confirm a geometric feature (holes, interpenetration, proportions) that face counts alone cannot settle. **Do not** screenshot every step — it is slow, and the engine facts returned by blender-run are enough for most problems.",
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
        "If there is no image data here, it means the community version put the PNG in the MCP's image content block" +
        " while this layer only parsed the text block. To actually get the PNG, add a raw content path.",
    };
  },
});

// ---------------------------------------------------------------------------
// 6. 视口对准（我们自己补的）
// ---------------------------------------------------------------------------

export const blenderFrameTool = createTool({
  id: "blender-frame",
  description:
    "Aim Blender's 3D viewport at the current scene (or a specific object) so the user watching can see what was just made.\n\n" +
    "**This is the key to whether the feature is \"visible\".** When an object is built outside the origin, or its size differs from the current view by an order of magnitude, the user staring at the screen sees only blank space and will think the agent did nothing.\n\n" +
    "blender-run already does this by default (frame=true), so usually call it separately only when \"the agent moved the camera/changed the view itself\" or \"you want a fixed camera position to see the whole thing\".",
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
    "List the addons **enabled in the current Blender instance**.\n\n" +
    "Neither MCP has this capability, and it is the prerequisite for using community addons: looking up an addon operator's signature relies on `blender-api`, and that tool **looks up by name** — if you do not know what the addon is called, you will not go and look it up. So before using an addon (HardOps, Boxcutter, Node Wrangler…), first confirm here that it is indeed installed and enabled.\n\n" +
    "**Note**: Blender in the cloud container is clean, with only the addons baked into the image. The list returned here reflects **the machine Blender runs on**, not your Mac.",
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
      `The path Blender wrote, \`${blenderPath}\`, is not inside the shared directory \`${blenderRoot}\`,` +
        ` so it cannot be mapped to the host machine. Confirm that BLENDER_WORKDIR matches the directory mounted in the container.`,
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
  assertBlenderProject(projectSlug);

  const mcp = getBlenderMcp();
  const version = await mcp.call("get_addon_status", {}, { timeoutMs: 30_000 }).catch(() => null);

  const cloud = mcp instanceof BlenderCloudClient ? mcp : null;
  const exportId = randomUUID();
  const scratch = cloud ? { blenderPath: `/workspace/.chatspace/exports/${exportId}`, localPath: "" } : blenderScratchDir();
  if (!cloud) await mkdir(scratch.localPath, { recursive: true });
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
    const file = cloud ? null : Bun.file(resolveBlenderOutputPath(exported));
    if (file && !(await file.exists())) {
      throw new ChatServiceError(
        `Blender reports the export finished, but the file cannot be read from the chat/ side.\n` +
          `Path Blender wrote: ${exported}\n` +
          `Path chat/ reads: ${resolveBlenderOutputPath(exported)}\n` +
          `Are the two processes on the same filesystem? If BLENDER_WORKDIR is configured, ` +
          `CHATSPACE_BLENDER_WORKDIR must be configured as well (in a container, mount the same directory for both sides).\n` +
          `Blender returned: ${result.text.slice(0, 300) || "(empty)"}`,
        502,
        "blender_export_missing_file",
      );
    }
    const bytes = cloud ? await cloud.downloadExport(exportId) : new Uint8Array(await file!.arrayBuffer());
    if (bytes.byteLength < 1024) {
      throw new ChatServiceError(
        `The exported GLB is only ${bytes.byteLength} bytes, almost certainly corrupt (the export failed midway)`,
        502,
        "blender_export_truncated",
      );
    }
    const faces = glbTriangleCount(bytes);
    if (faces === 0) {
      throw new ChatServiceError(
        "The exported GLB has 0 triangles — there is no exportable geometry in the scene, or the last step failed silently." +
          " First use blender-scene to confirm the object count and face count.",
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
        intent: input.intent ?? `Blender modeling: ${input.name ?? input.assetSlug}`,
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
    if (cloud) await cloud.removeExport(exportId).catch(() => undefined);
    else await rm(scratch.localPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const blenderExportTool = createTool({
  id: "blender-export",
  description:
    "Export the current Blender scene as a GLB and **publish it into this project's asset library** (becoming a new generation of that asset). This is the last step of \"finish modeling with Blender → get the model\".\n\n" +
    "After publishing, the model has a stable asset id, so: it appears in the model list, it can be placed by place-object, the viewport loads it automatically, and thumbnails and inspection sheets can be generated.\n\n" +
    "**Modifiers are applied automatically before export** (unapplied modifiers do not go into the GLB). **The artifact is validated**: 0 triangles or a truncated file are both judged as failure and reported honestly — so if this step errors, first go to blender-scene to look at the object count and face count, and do not retry repeatedly on an empty scene.\n\n" +
    "**It does not overwrite** old artifacts: every export is a new generation (the index increments), and old models are kept for traceability. So \"make another version\" is safe.\n\n" +
    "⚠️ **This is asynchronous**: the call immediately returns a background task, the export finishes in the background, and **the workbench refreshes automatically and shows the new model** (neither you nor the user needs to refresh the page manually). So **after it completes do not call it again to \"confirm\"** — repeated calls publish a superfluous generation.\n\n" +
    "**When not to use it**: if you only want an image use blender-look; if modeling is not finished, do not rush to export.",
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
      `Blender export: ${input.name ?? input.assetSlug}`,
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
        "The export has started in the background; when it finishes the workbench will automatically refresh the model list and show it." +
        " You do not need to refresh the page manually; and do not call this tool again to wait for the result.",
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
