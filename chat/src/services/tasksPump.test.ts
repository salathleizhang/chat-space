import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killJsTimers } from "../common/deadTimers.testkit";
import { ChatServiceError } from "../common/errors";
import { formatRequestSidecarName } from "../common/indexedFiles";
import { projectTaskFile, projectTaskWorkDir } from "../common/libraryPaths";
import { pollProviderTask } from "../common/polling";
import { resetTaskPumps } from "../common/taskPump";
import { GenerationTaskSchema } from "../dto/tasks";
import { RequestSidecarSchema } from "../dto/library";
import { LocalFileStorage, setAssetStorage, writeJson } from "./assetStorage";
import {
  STALLED_TASK_WARN_MS,
  clearTasks,
  listTasks,
  startCustomTask,
} from "./tasks";

/**
 * 2026-10-03 事故的端到端回归：**读任务列表**（工作台每秒一次的 `GET /api/tasks`）
 * 本身就是外部时钟。本进程定时器停摆时，生成任务照样走完、照样能被看见、
 * 进程重启后照样自动接上——这三条是这次改造的全部目的。
 */

const root = await mkdtemp(join(tmpdir(), "chatspace-task-pump-test-"));
const storage = new LocalFileStorage(root);

beforeAll(() => {
  setAssetStorage(storage);
});

afterAll(async () => {
  setAssetStorage(undefined);
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearTasks();
  resetTaskPumps();
});

afterEach(() => {
  setSystemTime();
  resetTaskPumps();
});

/** 假供应商：前 `running` 次说还在跑，第 `running + 1` 次成功。 */
function fakeProviderPoll(running: number) {
  let seen = 0;
  return {
    label: "假供应商",
    timeoutMs: 60_000,
    requestTimeoutMs: 5_000,
    pollIntervalMs: 20,
    attempt: async () => {
      seen += 1;
      return { status: seen > running ? "success" : "running" };
    },
    statusOf: (result: { status: string }) => result.status,
    isDone: (result: { status: string }) => result.status === "success",
    failureOf: () => undefined,
    timeoutError: () => new ChatServiceError("假超时", 504, "fake_timeout"),
  } as const;
}

/** 反复读任务列表直到任务离开 running（读一次 = 工作台的一次心跳）。 */
async function pumpUntilSettled(projectSlug: string, taskId: string, timeoutMs = 3_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const tasks = await listTasks(projectSlug);
    const found = tasks.find((task) => task.id === taskId);
    if (found && found.status !== "running") return found;
    if (Date.now() >= until) return found;
  }
}

describe("定时器停摆时，读任务列表就是外部时钟", () => {
  test("任务靠 GET /api/tasks 这条路径把轮询推完", async () => {
    const projectSlug = "p-task-pump";
    const timers = killJsTimers();
    try {
      const task = startCustomTask("3d", projectSlug, "假生成", async (context) => {
        await context.setPhase("generating");
        return pollProviderTask(fakeProviderPoll(2));
      });
      // 注意：这里没有 sleep、没有定时器——唯一的推进来源是 listTasks 里的 tickTaskPumps()
      const settled = await pumpUntilSettled(projectSlug, task.id);
      expect(settled?.status).toBe("succeeded");
      expect(settled?.phase).toBe("completed");
      expect(timers.swallowed).toBeGreaterThan(0); // 证明确实处在"定时器停摆"状态
    } finally {
      timers.restore();
    }
  });

  test("静默超过 90 秒时，读任务列表带上 stall 诊断（而不再是等 60 分钟）", async () => {
    const projectSlug = "p-task-stall";
    const task = startCustomTask("3d", projectSlug, "永不结束的生成", async () => {
      // 永不 settle：模拟"链路还在，但一直没有进展"
      await new Promise(() => undefined);
    });
    const fresh = (await listTasks(projectSlug)).find((item) => item.id === task.id);
    expect(fresh?.stall).toBeUndefined();

    setSystemTime(new Date(Date.now() + STALLED_TASK_WARN_MS + 5_000));
    const stale = (await listTasks(projectSlug)).find((item) => item.id === task.id);
    expect(stale?.status).toBe("running");
    expect(stale?.stall?.silentForMs).toBeGreaterThanOrEqual(STALLED_TASK_WARN_MS);
    // 进程里还有闸门照看它 = 下一次外部 tick 就能推动，不需要人工介入
    expect(stale?.stall?.pumpActive).toBe(true);
  });

  test("进程重启后：running 任务自动凭侧写续跑，不需要人工点续跑", async () => {
    const projectSlug = "p-task-restart";
    const taskId = "task-stale-restart";
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    // 上一个进程留下的记录：running + 旧 bootId（当前进程认领不回来）
    await writeJson(storage, projectTaskFile(projectSlug, taskId), GenerationTaskSchema, {
      id: taskId,
      workflowId: "3d",
      projectSlug,
      subject: "旧进程留下的 3D 生成",
      status: "running",
      phase: "generating",
      bootId: "boot-of-a-dead-process",
      assetSlug: "chair",
      createdAt,
      updatedAt: createdAt,
    });
    // 已提交（已付费）的侧写还留在任务工作目录里
    const sidecarName = formatRequestSidecarName(0, "chair");
    await writeJson(
      storage,
      `${projectTaskWorkDir(projectSlug, taskId)}/${sidecarName}`,
      RequestSidecarSchema,
      {
        schemaVersion: 1,
        index: 0,
        slug: "chair",
        provider: "tripo",
        model: "v3/generation/image-to-model",
        providerTaskId: "tripo-task-already-paid",
        params: { generation_mode: "single" },
        status: "running",
        outputs: [],
        createdAt,
        updatedAt: createdAt,
      },
    );
    clearTasks(); // 新进程：内存表为空

    const tasks = await listTasks(projectSlug);
    const stale = tasks.find((item) => item.id === taskId);
    expect(stale?.status).toBe("failed");
    expect(stale?.error).toContain("resumed automatically from the sidecar");
    const resumed = tasks.find((item) => item.workflowId === "resume");
    expect(resumed?.resumeSidecar).toBe(
      `projects/${projectSlug}/tasks/${taskId}/work/${sidecarName}`,
    );
  });

  test("没有已提交侧写的中断任务不会被自动重新付费：照旧只给人工提示", async () => {
    const projectSlug = "p-task-nosidecar";
    const taskId = "task-stale-nosidecar";
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    await writeJson(storage, projectTaskFile(projectSlug, taskId), GenerationTaskSchema, {
      id: taskId,
      workflowId: "3d",
      projectSlug,
      subject: "没提交成功就断了",
      status: "running",
      phase: "generating",
      bootId: "boot-of-a-dead-process",
      assetSlug: "lamp",
      createdAt,
      updatedAt: createdAt,
    });
    clearTasks();

    const tasks = await listTasks(projectSlug);
    const stale = tasks.find((item) => item.id === taskId);
    expect(stale?.status).toBe("failed");
    expect(stale?.error).toContain("resume-generation");
    expect(tasks.some((item) => item.workflowId === "resume")).toBe(false);
  });
});
