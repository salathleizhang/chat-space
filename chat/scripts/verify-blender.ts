/**
 * Blender 链路验收脚本 —— 逐层回答"它到底通没通"。
 *
 * ## 为什么不写成一段文档让你照着敲
 *
 * 这条链上有四层，**每一层的失败症状都长得像另一层的失败**：
 *
 *   1. 容器起不来        → 日志停在 pulseaudio / "Unknown Service: custom_startup"
 *   2. 端口通但连不上    → `source=error`（而 `nc` 说"通"，那是 Docker 代理接受的）
 *   3. 连上了但执行不了  → `Connection closed before receiving any data`（socat 少了 nodelay）
 *   4. 执行了但拿不到事实 → 面数全是 undefined（用了社区版的 get_scene_info）
 *
 * 所以这个脚本**逐层报**：每层单独给结论，哪层红了一眼就知道该往哪看。
 *
 * ## 用法
 *
 *   export PATH="$HOME/.bun/bin:$PATH"
 *
 *   # 只验到"能建模"（不需要项目）
 *   bun run --cwd chat scripts/verify-blender.ts
 *
 *   # 连导出一起验（需要一个真实项目 slug；且容器要挂着共享卷）
 *   BLENDER_WORKDIR=/workspace \
 *   CHATSPACE_BLENDER_WORKDIR="$HOME/ChatSpace/blender-work" \
 *   bun run --cwd chat scripts/verify-blender.ts p-mu5l6om3
 *
 * 环境变量（都有默认值，只有导出才需要后两个）：
 *   BLENDER_HOST / BLENDER_PORT       容器暴露出来的地址，默认 127.0.0.1:9876
 *   BLENDER_WORKDIR                   **容器看到的**共享目录，如 /workspace
 *   CHATSPACE_BLENDER_WORKDIR         **宿主机看到的**同一个目录
 */

import { listTasks } from "../src/services/tasks";
import { buildRequestContext } from "../src/services/workflowRuns";
import {
  blenderExportTool,
  blenderRunTool,
  blenderSceneTool,
  blenderSessionTool,
} from "../src/mastra/tools/blenderOps";

const projectSlug = process.argv[2];
const ctx = {
  requestContext: buildRequestContext({ projectSlug: projectSlug ?? "blender-verify" }),
} as never;

let failed = 0;

function ok(label: string, detail: string): void {
  console.log(`  ✅ ${label}  ${detail}`);
}
function bad(label: string, detail: string): void {
  failed += 1;
  console.log(`  ❌ ${label}  ${detail}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

const HOST = process.env.BLENDER_HOST ?? "127.0.0.1";
const PORT = process.env.BLENDER_PORT ?? "9876";

// ---------------------------------------------------------------------------
section(`Layer 1 · Connection (${HOST}:${PORT})`);
{
  const r = (await blenderSessionTool.execute!({} as never, ctx)) as {
    connected: boolean;
    error?: string;
    hint?: string;
    addon?: unknown;
  };
  if (r.connected) {
    ok("handshake succeeded", JSON.stringify(r.addon ?? {}).slice(0, 120));
  } else {
    bad("cannot connect", String(r.error ?? "").slice(0, 160));
    console.log(`     ↳ ${r.hint ?? ""}`);
    console.log("\nStopped at layer 1: the following layers are meaningless. Look at the container first:");
    console.log("     docker logs docker-blender-1 | grep chatspace");
    console.log("     It should contain the lines \"self-check passed\" and \"relay 9877 is ready\".");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
section("Layer 2 · Execute one step of code");
{
  const r = (await blenderRunTool.execute!(
    {
      code: "print('CS_VERIFY_OK')",
      step: "Verification: minimal execution",
      frame: false,
    } as never,
    ctx,
  )) as { output?: string; facts?: unknown; factsUnavailable?: string };
  if (/CS_VERIFY_OK/.test(r.output ?? "")) {
    ok("the code really ran inside Blender", `${(r.output ?? "").length} bytes returned`);
  } else {
    bad("execution failed", String(r.output ?? "").slice(0, 160));
    if (/Connection closed/.test(r.output ?? "")) {
      console.log("     ↳ This is the classic symptom of socat missing nodelay.");
    }
  }
}

// ---------------------------------------------------------------------------
section("Layer 3 · Engine facts (face count / bounding box / degenerate detection)");
{
  await blenderRunTool.execute!(
    {
      code: [
        "import bpy, bmesh",
        "m = bpy.data.meshes.new('verify')",
        "bm = bmesh.new()",
        "bmesh.ops.create_cube(bm, size=2.0)",
        "bm.to_mesh(m)",
        "bm.free()",
        "o = bpy.data.objects.new('CS_Verify_Cube', m)",
        "bpy.context.scene.collection.objects.link(o)",
      ].join("\n"),
      step: "Verification: build a 2m cube",
      frame: false,
    } as never,
    ctx,
  );
  const s = (await blenderSceneTool.execute!({} as never, ctx)) as {
    scene?: {
      totalFaces?: number;
      objectCount?: number;
      bounds?: { size?: number[] };
      degenerate?: string[];
      objects?: { name: string; faces?: number }[];
    };
  };
  const sc = s.scene;
  // 这一层是最容易"看起来绿其实空转"的：社区版的 get_scene_info 只返回
  // name/type/location，没有面数——那时 totalFaces 会静默地是 undefined。
  if (typeof sc?.totalFaces !== "number") {
    bad("cannot get the face count", `totalFaces=${String(sc?.totalFaces)} — check whether get_scene_info was used by mistake`);
  } else if (!(sc.totalFaces > 0)) {
    bad("there is not a single face in the scene", `totalFaces=${sc.totalFaces}`);
  } else {
    const mine = (sc.objects ?? []).find((o) => o.name === "CS_Verify_Cube");
    ok(
      "face count and bounding box both obtained",
      `total ${sc.totalFaces} faces / ${sc.objectCount} objects / size ${JSON.stringify(sc.bounds?.size)} / our cube ${mine?.faces} faces / degenerate items ${JSON.stringify(sc.degenerate)}`,
    );
  }
}

// ---------------------------------------------------------------------------
section("Layer 4 · Export into the asset library");
if (!projectSlug) {
  console.log("  ⏭  Skipped (no project slug given). To verify this layer:");
  console.log("     BLENDER_WORKDIR=/workspace CHATSPACE_BLENDER_WORKDIR=\"$HOME/ChatSpace/blender-work\" \\");
  console.log("       bun run --cwd chat scripts/verify-blender.ts <project slug>");
  console.log("     Requirement: the container has the shared volume mounted (docker compose up mounts it by default)");
} else if (!process.env.BLENDER_WORKDIR || !process.env.CHATSPACE_BLENDER_WORKDIR) {
  console.log("  ⏭  Skipped (missing BLENDER_WORKDIR / CHATSPACE_BLENDER_WORKDIR).");
  console.log("     Blender inside the container writes a container path while the host reads a different path; both must be given.");
} else {
  try {
    /*
      **导出是异步的，所以验收必须等任务落定再读 `result`。**

      工具刻意返回一个后台任务而不是同步结果（`blenderOps.ts` 里记了原因：同步发布时资产
      确实写进了库，但 app 不会重新拉列表，用户得手动刷新才看得见）。此前这个脚本还按同步
      结果读 `bytes`，于是拿到的是 `{task:{id,status:"running"}}` → `bytes` 恒为 undefined
      → 无论导出成没成，一律报「导出产物太小」。**那是脚本与工具契约脱节，不是链路坏了。**

      判据因此改成三步：等任务离开 running → 看它是 succeeded 还是 failed →
      才从 `result` 里取事实。顺带把失败原因如实透出来（原来会把真实报错吞掉）。
    */
    const started = (await blenderExportTool.execute!(
      {
        assetSlug: "blender-verify",
        name: "Blender acceptance artifact",
        intent: "produced by the verification script, safe to delete",
      } as never,
      ctx,
    )) as { task?: { id?: string } };
    const taskId = started.task?.id;
    if (!taskId) {
      bad("export did not start a task", JSON.stringify(started).slice(0, 160));
    } else {
      const deadline = Date.now() + 180_000;
      // `listTasks()` 自己会 tick 任务闸门，所以这个轮询同时是外部时钟——即使进程内
      // 定时器被压住，任务也能被推着走完（见 AGENTS.md 第二节第 15/16 条）。
      const find = async () =>
        (await listTasks(projectSlug)).find((candidate) => candidate.id === taskId);
      let task = await find();
      while (task?.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        task = await find();
      }

      if (!task) {
        bad("cannot read the export task", taskId);
      } else if (task.status === "running") {
        bad("export timed out", `waited 180s and it still has not settled (phase=${task.phase})`);
      } else if (task.status === "failed") {
        bad("export failed", String(task.error ?? "").slice(0, 200));
        if (/读不到文件/.test(String(task.error ?? ""))) {
          console.log("     ↳ The two ends of the shared directory do not line up: the container writes /workspace, and the host must be able to read that same directory.");
        }
      } else {
        const r = (task.result ?? {}) as {
          glbPath?: string;
          bytes?: number;
          faces?: number;
          blenderVersion?: string;
          index?: number;
        };
        if ((r.bytes ?? 0) > 1024) {
          ok(
            "exported and published successfully",
            `${r.glbPath} · ${r.bytes} bytes · ${r.faces} faces · Blender ${r.blenderVersion} · generation ${r.index}`,
          );
          console.log(`     ↳ On the host: the directory alongside ~/ChatSpace/${r.glbPath} should contain asset.json and the request sidecar`);
        } else {
          bad("the export artifact is too small", JSON.stringify(r).slice(0, 160));
        }
      }
    }
  } catch (error) {
    bad("export failed", String((error as Error).message).slice(0, 200));
    if (/读不到文件/.test(String((error as Error).message))) {
      console.log("     ↳ The two ends of the shared directory do not line up: the container writes /workspace, and the host must be able to read that same directory.");
    }
  }
}

// ---------------------------------------------------------------------------
console.log();
if (failed === 0) {
  console.log("✅ Verification passed.");
} else {
  console.log(`❌ ${failed} layer(s) did not pass (each layer above is an independent conclusion; start reading from the first red spot).`);
}
process.exit(failed === 0 ? 0 : 1);
