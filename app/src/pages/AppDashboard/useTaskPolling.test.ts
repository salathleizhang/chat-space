import { beforeEach, describe, expect, mock, test } from "bun:test";
import { deferred, flush, renderHook } from "../../test-utils";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import type { GenerationTask } from "../../shared/lib/workflowClient";

/**
 * `mock.module` 在 bun 里是全局且**整体替换**的：只写 `{ listTasks }` 会把
 * `uploadSource` 等其余导出一并抹掉，而 `useAgentChat` 依赖它们——同一次运行里
 * 别的测试文件就会因为找不到导出而崩。所以要把真实导出摊平后只覆盖需要的那个。
 */
const actualWorkflowClient = await import("../../shared/lib/workflowClient");
const listTasks = mock(async (_project: string): Promise<GenerationTask[]> => []);
mock.module("../../shared/lib/workflowClient", () => ({
  ...actualWorkflowClient,
  listTasks,
}));

const { useTaskPolling } = await import("./useTaskPolling");

function task(overrides: Partial<GenerationTask> = {}): GenerationTask {
  return {
    id: "t1",
    status: "running",
    subject: "生成椅子",
    ...overrides,
  } as GenerationTask;
}

function harnessFor(projectSlug: string | null) {
  const pushAssistant = mock((_content: string, _images?: string[]) => "completion-message");
  const updateMessage = mock((_id: string, _updater: (message: unknown) => unknown) => {});
  const setActivity = mock((_activity: unknown) => {});
  const bumpRefresh = mock(() => {});
  const mount = () =>
    renderHook(
      () =>
        useTaskPolling({
          projectSlug: projectSlug ?? "",
          assets: [],
          pushAssistant,
          updateMessage: updateMessage as never,
          setActivity,
          bumpRefresh,
        }),
      undefined,
    );
  return { pushAssistant, updateMessage, setActivity, bumpRefresh, mount };
}

beforeEach(() => {
  listTasks.mockReset();
});

describe("useTaskPolling", () => {
  test("单个后台任务把具体动作显示在 Agent 状态栏", async () => {
    listTasks.mockImplementation(async () => [
      task({ status: "running", subject: "贴图生成：chair" }),
    ]);
    const { setActivity, mount } = harnessFor("p1");
    const h = await mount();

    await flush();
    h.result.current.pollTasks();
    await flush();

    expect(setActivity).toHaveBeenCalledWith({
      state: "working",
      message: "正在执行：贴图生成：chair",
    });
    await h.unmount();
  });

  test("挂载期间正常回报已完成的任务", async () => {
    listTasks.mockImplementation(async () => [
      task({ id: "done-1", status: "succeeded", subject: "生成椅子" }),
    ]);
    const { pushAssistant, setActivity, mount } = harnessFor("p1");
    const h = await mount();

    await flush();
    h.result.current.pollTasks();
    await flush();

    expect(pushAssistant).toHaveBeenCalledTimes(1);
    expect(pushAssistant.mock.calls[0]![0]).toContain("生成椅子");
    expect(setActivity).toHaveBeenCalled();
    await h.unmount();
  });

  /**
   * 这条是 P0-1 的核心：`tick` 里 `await listTasks(...)` 之后全是对组件状态的写入，
   * 请求在途时卸载的话，旧实现照样会 setActivity + 排下一轮 4s 定时器，
   * 于是离开工作台后轮询永远跑下去。
   */
  test("请求在途时卸载：不再回报、不再排下一轮", async () => {
    const pending = deferred<GenerationTask[]>();
    listTasks.mockImplementation(() => pending.promise);
    const { pushAssistant, setActivity, bumpRefresh, mount } = harnessFor("p1");
    const h = await mount();

    await flush();
    h.result.current.pollTasks();
    await flush();
    expect(listTasks).toHaveBeenCalledTimes(1);

    await h.unmount();

    // 请求现在才回来，而且报告"还在跑"——旧实现会据此排下一轮
    pending.resolve([task({ status: "running" })]);
    await flush(20);

    expect(setActivity).not.toHaveBeenCalled();
    expect(pushAssistant).not.toHaveBeenCalled();
    expect(bumpRefresh).not.toHaveBeenCalled();
    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  test("卸载之后再调 pollTasks 也不会发起请求", async () => {
    listTasks.mockImplementation(async () => [task({ status: "running" })]);
    const { mount } = harnessFor("p1");
    const h = await mount();
    await flush();

    const { pollTasks } = h.result.current;
    const callsBeforeUnmount = listTasks.mock.calls.length;
    await h.unmount();

    pollTasks();
    await flush(20);

    expect(listTasks).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  test("没有项目时不发起请求", async () => {
    listTasks.mockImplementation(async () => []);
    const { mount } = harnessFor(null);
    const h = await mount();
    await flush();

    h.result.current.pollTasks();
    await flush();

    expect(listTasks).not.toHaveBeenCalled();
    await h.unmount();
  });

  test("任务接口失败时明确提示并保留自动重试，而不是伪装成空任务", async () => {
    listTasks.mockImplementation(async () => {
      throw new Error("chat 服务不可达");
    });
    const { pushAssistant, setActivity, mount } = harnessFor("p1");
    const h = await mount();

    h.result.current.pollTasks(["pending-1"]);
    await flush();

    expect(pushAssistant).toHaveBeenCalledTimes(1);
    expect(pushAssistant.mock.calls[0]![0]).toContain("chat 服务不可达");
    expect(setActivity).toHaveBeenCalledWith({
      state: "working",
      message: "后台任务状态读取失败，4 秒后重试",
    });
    await h.unmount();
  });

  test("3D 任务完成后把新模型缩略图回填到同一条对话消息", async () => {
    const modelPath = "projects/p1/assets/chair/1-chair.glb";
    const thumbnailPath = "projects/p1/assets/chair/.thumb-1-chair.png";
    listTasks.mockImplementation(async () => [
      task({
        id: "done-3d",
        workflowId: "3d",
        status: "succeeded",
        result: { files: [modelPath] },
      }),
    ]);
    const { updateMessage, mount } = harnessFor("p1");
    const h = await mount();

    h.result.current.pollTasks();
    await flush();
    h.result.current.onThumbnailGenerated({} as LibraryAsset, modelPath, thumbnailPath);

    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0]![0]).toBe("completion-message");
    const updater = updateMessage.mock.calls[0]![1] as (message: {
      images?: string[];
    }) => { images?: string[] };
    expect(updater({}).images).toEqual([thumbnailPath]);
    await h.unmount();
  });

  test("指定批次全部结束后只回调一次，供 Agent 自动续跑", async () => {
    listTasks.mockImplementation(async () => [
      task({ id: "done-1", status: "succeeded", subject: "生成椅子" }),
      task({ id: "done-2", status: "failed", subject: "生成桌子", error: "超时" }),
      task({ id: "old", status: "succeeded", subject: "旧任务" }),
    ]);
    const onSettled = mock((_settlement: unknown) => {});
    const { pushAssistant, mount } = harnessFor("p1");
    const h = await mount();

    h.result.current.pollTasks(["done-1", "done-2"], onSettled as never);
    await flush();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]).toMatchObject({
      tasks: [
        { id: "done-1", status: "succeeded" },
        { id: "done-2", status: "failed" },
      ],
    });
    expect(pushAssistant).toHaveBeenCalledTimes(2);
    expect(pushAssistant.mock.calls.flat().join(" ")).not.toContain("旧任务");
    await h.unmount();
  });
});
