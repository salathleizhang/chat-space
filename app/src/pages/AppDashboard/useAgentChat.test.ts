import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { deferred, flush, renderHook } from "../../test-utils";
import type { ProjectPlan } from "../../shared/lib/libraryApi";
import type {
  AskUserAnswer,
  AskUserQuestion,
  OutgoingChatMessage,
} from "../../shared/lib/chatClient";
import type { ChatMessage } from "../../widgets/AgentDock";

/**
 * 只 mock `chatClient` 一个模块——它是唯一会真的发网络请求的地方，而且运行时
 * 就只导出 `streamChat` 一个符号，整体替换不会丢东西。
 *
 * 其余依赖一律走真实接缝：API key 直接写 localStorage（happy-dom 提供），
 * `libraryApi`/`workflowClient` 在本文件的用例里根本不会被调用，没必要替换。
 * `mock.module` 在 bun 里是**全局且整体替换**的，替掉一个模块就等于删掉它其余的
 * 导出，会串到同一次运行的其他测试文件里去（`useTaskPolling` 找不到 `listTasks`
 * 就是这么来的）——所以 mock 的范围要压到最小。
 */
const streamChat = mock(async (..._args: unknown[]) => {});
mock.module("../../shared/lib/chatClient", () => ({ streamChat }));

const { useAgentChat } = await import("./useAgentChat");

type Handlers = {
  onDelta: (t: string) => void;
  onTool: (name: string, toolCallId?: string, args?: Record<string, unknown>) => void;
  onToolResult: (
    name: string,
    toolCallId?: string,
    images?: string[],
    taskIds?: string[],
    plan?: ProjectPlan,
    question?: AskUserQuestion,
  ) => void;
  onToolError: (name: string, toolCallId?: string) => void;
  onError: (m: string) => void;
  onDone: () => void;
};

const handlersOf = (call: number) => streamChat.mock.calls[call]![3] as Handlers;
const signalOf = (call: number) => streamChat.mock.calls[call]![5] as AbortSignal;

const PLAN: ProjectPlan = {
  schemaVersion: 1,
  revision: 1,
  title: "生成椅子",
  steps: [{ id: "model", content: "生成模型", status: "in_progress" }],
  updatedAt: "2026-08-09T00:00:00.000Z",
};

function harness() {
  const pushAssistant = mock((_c: string) => {});
  const pushMessage = mock((_message: ChatMessage) => {});
  const updateMessage = mock(
    (_id: string, _updater: (message: ChatMessage) => ChatMessage) => {},
  );
  const onPlanUpdated = mock(() => {});
  const pollTasks = mock((..._args: unknown[]) => {});
  const bumpRefresh = mock(() => {});
  const messagesRef = { current: [] as ChatMessage[] };
  const mount = (slug = "proj-a") =>
    renderHook(
      (projectSlug: string) =>
        useAgentChat({
          projectSlug,
          messagesRef,
          pushMessage,
          pushAssistant,
          updateMessage,
          appendTo: () => {},
          setActivity: () => {},
          pollTasks: pollTasks as never,
          bumpRefresh,
          sessionPlan: null,
          onPlanUpdated,
        }),
      slug,
    );
  return {
    messagesRef,
    bumpRefresh,
    pushAssistant,
    pushMessage,
    updateMessage,
    onPlanUpdated,
    pollTasks,
    mount,
  };
}

beforeEach(() => {
  streamChat.mockReset();
  streamChat.mockImplementation(async () => {});
  localStorage.clear();
  localStorage.setItem("gabo.apiKeys", JSON.stringify({ openai: "test-key" }));
});

describe("useAgentChat 服务端凭证", () => {
  test("浏览器不持有 LLM key 时仍能发送请求", async () => {
    localStorage.removeItem("gabo.apiKeys");
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成一把椅子"));

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(streamChat.mock.calls[0]![2]).toEqual({
      provider: "volcengine",
      baseUrl: undefined,
      model: "deepseek-v4-1-flash-260910",
    });
    expect(streamChat.mock.calls[0]![4]).toMatchObject({
      threeDModel: "seed3d-2",
      imageGenerateModel: "seedream-5",
    });

    await h.unmount();
  });

  test("旧浏览器密钥与旧 OpenAI 设置不会进入新请求", async () => {
    localStorage.setItem(
      "gabo.llmSettings",
      JSON.stringify({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      }),
    );
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成一把椅子"));

    expect(streamChat.mock.calls[0]![2]).toEqual({
      provider: "volcengine",
      baseUrl: undefined,
      model: "deepseek-v4-1-flash-260910",
    });
    expect(Object.keys(streamChat.mock.calls[0]![4] ?? {}).some((key) => key.endsWith("ApiKey"))).toBe(false);

    await h.unmount();
  });

  test("图片生成模型偏好随下一轮请求发送", async () => {
    localStorage.setItem(
      "gabo.imageGenerateModelSettings:v1",
      JSON.stringify({ model: "seedream-5" }),
    );
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成一张机器人参考图"));

    expect(streamChat.mock.calls[0]![4]).toMatchObject({
      imageGenerateModel: "seedream-5",
    });

    await h.unmount();
  });

  test("选中资产作为消息部件发送，历史会永久保留当时的目标", async () => {
    const { mount } = harness();
    const h = await mount();

    await act(async () =>
      h.result.current.send("把它改成红色", undefined, [
        {
          assetSlug: "chair",
          name: "休闲椅",
          thumbPath: "projects/proj-a/assets/chair/.thumb-0-chair.png",
          kind: "model",
        },
      ]),
    );

    expect(streamChat.mock.calls[0]![1]).toEqual([
      {
        role: "user",
        content: [
          { type: "asset", assetSlug: "chair" },
          { type: "text", text: "把它改成红色" },
        ],
      },
    ]);

    await h.unmount();
  });

  test("图片消息只把用户指令和真实图片部件发给 LLM，不注入文件名或资源路径", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      Response.json({ path: "projects/proj-a/source/0-bedroom.png" }),
    ) as unknown as typeof fetch;
    const { mount, pushMessage } = harness();
    const h = await mount();

    try {
      await act(async () => {
        h.result.current.send(
          "分析卧室里的家具",
          [new File(["image bytes"], "bedroom.png", { type: "image/png" })],
        );
        await flush();
      });

      expect(streamChat.mock.calls[0]![1]).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "分析卧室里的家具" },
            { type: "image", path: "projects/proj-a/source/0-bedroom.png" },
          ],
        },
      ]);
      expect(pushMessage.mock.calls[0]![0]).toMatchObject({
        role: "user",
        content: "分析卧室里的家具",
        images: ["projects/proj-a/source/0-bedroom.png"],
      });
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });

  test("多张图片逐张上传，并作为同一条消息按选择顺序发送", async () => {
    const originalFetch = globalThis.fetch;
    const uploadedNames: string[] = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const fileName = (JSON.parse(String(init?.body)) as { fileName: string }).fileName;
      uploadedNames.push(fileName);
      return Response.json({ path: `projects/proj-a/source/${uploadedNames.length}-${fileName}` });
    }) as unknown as typeof fetch;
    const { mount, pushMessage } = harness();
    const h = await mount();

    try {
      await act(async () => {
        h.result.current.send("比较两张图", [
          new File(["first"], "first.png", { type: "image/png" }),
          new File(["second"], "second.webp", { type: "image/webp" }),
        ]);
        await flush(20);
      });

      expect(uploadedNames).toEqual(["first.png", "second.webp"]);
      expect(pushMessage.mock.calls.filter(([message]) => message.role === "user")).toHaveLength(1);
      expect(pushMessage.mock.calls[0]![0]).toMatchObject({
        content: "比较两张图",
        images: [
          "projects/proj-a/source/1-first.png",
          "projects/proj-a/source/2-second.webp",
        ],
      });
      expect(streamChat.mock.calls[0]![1]).toEqual([{
        role: "user",
        content: [
          { type: "text", text: "比较两张图" },
          { type: "image", path: "projects/proj-a/source/1-first.png" },
          { type: "image", path: "projects/proj-a/source/2-second.webp" },
        ],
      }]);
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });

  test("没有用户文本的图片消息只补最小看图指令，不注入附件元数据", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      Response.json({ path: "projects/proj-a/source/0-image.png" }),
    ) as unknown as typeof fetch;
    const { mount } = harness();
    const h = await mount();

    try {
      await act(async () => {
        h.result.current.send(
          "",
          [new File(["image bytes"], "image.png", { type: "image/png" })],
        );
        await flush();
      });

      expect(streamChat.mock.calls[0]![1]).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Please review this image." },
            { type: "image", path: "projects/proj-a/source/0-image.png" },
          ],
        },
      ]);
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });

  test("图片上传在途时卸载：continuation 不写消息也不启动 Agent", async () => {
    const originalFetch = globalThis.fetch;
    const upload = deferred<Response>();
    globalThis.fetch = mock(async () => upload.promise) as unknown as typeof fetch;
    const { mount, pushMessage } = harness();
    const h = await mount("proj-a");
    let mounted = true;

    try {
      await act(async () => {
        h.result.current.send(
          "分析这张图",
          [new File(["image bytes"], "scene.png", { type: "image/png" })],
        );
        await flush();
      });
      await h.unmount();
      mounted = false;

      upload.resolve(Response.json({ path: "projects/proj-a/source/0-scene.png" }));
      await flush(20);

      expect(pushMessage).not.toHaveBeenCalled();
      expect(streamChat).not.toHaveBeenCalled();
    } finally {
      if (mounted) await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });

  test("多图上传期间阻止第二次发送，停止后不启动 Agent", async () => {
    const originalFetch = globalThis.fetch;
    const upload = deferred<Response>();
    let signal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return upload.promise;
    }) as unknown as typeof fetch;
    const { mount, pushMessage } = harness();
    const h = await mount();

    try {
      await act(async () => {
        h.result.current.send("比较", [
          new File(["first"], "first.png", { type: "image/png" }),
          new File(["second"], "second.png", { type: "image/png" }),
        ]);
        await flush();
      });
      expect(h.result.current.streaming).toBe(true);
      await act(async () => h.result.current.send("不该并发"));
      expect(pushMessage).not.toHaveBeenCalled();

      await act(async () => h.result.current.stopStream());
      expect(signal?.aborted).toBe(true);
      upload.resolve(Response.json({ path: "projects/proj-a/source/0-first.png" }));
      await flush(20);
      expect(pushMessage).not.toHaveBeenCalled();
      expect(streamChat).not.toHaveBeenCalled();
      expect(h.result.current.streaming).toBe(false);
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("useAgentChat 并发不变量", () => {
  test("update-plan 完成时通知页面捕获当前会话的计划快照", async () => {
    const { mount, onPlanUpdated } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("制定一个三步计划"));
    await act(async () =>
      handlersOf(0).onToolResult(
        "update-plan",
        "tool-plan",
        undefined,
        undefined,
        PLAN,
      ),
    );

    expect(onPlanUpdated).toHaveBeenCalledTimes(1);
    expect(onPlanUpdated).toHaveBeenCalledWith(PLAN);

    await act(async () => handlersOf(0).onDone());
    await act(async () => h.result.current.send("继续"));
    expect(streamChat.mock.calls[1]![4]).toMatchObject({ plan: PLAN });
    await h.unmount();
  });

  test("兼容旧服务发出的 updatePlanTool 名称并刷新计划", async () => {
    const { mount, onPlanUpdated } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("制定一个三步计划"));
    await act(async () =>
      handlersOf(0).onToolResult(
        "updatePlanTool",
        "tool-plan",
        undefined,
        undefined,
        PLAN,
      ),
    );

    expect(onPlanUpdated).toHaveBeenCalledTimes(1);
    await h.unmount();
  });

  test("后台任务结束后把结果送回同一会话并自动继续", async () => {
    const { mount, pollTasks } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成椅子并继续完成计划"));
    await act(async () =>
      handlersOf(0).onToolResult(
        "start-3d-batch",
        "tool-task",
        undefined,
        ["task-1"],
      ),
    );
    expect(pollTasks).toHaveBeenCalledTimes(1);
    expect(pollTasks.mock.calls[0]![0]).toEqual(["task-1"]);

    await act(async () => handlersOf(0).onDone());
    const onSettled = pollTasks.mock.calls[0]![1] as (value: unknown) => void;
    await act(async () =>
      onSettled({
        tasks: [
          {
            id: "task-1",
            workflowId: "3d",
            projectSlug: "proj-a",
            subject: "3D 生成：椅子",
            status: "succeeded",
          },
        ],
      }),
    );
    await flush(20);

    expect(streamChat).toHaveBeenCalledTimes(2);
    // 任务完成不是用户发言：它走 resume，不进历史
    expect(streamChat.mock.calls[1]![4]).toMatchObject({
      resume: {
        kind: "tasks",
        text: expect.stringContaining("[Background tasks finished]"),
      },
    });
    await h.unmount();
  });

  test("SceneJob 的总任务完成后自动继续会话", async () => {
    const { mount, pollTasks } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成完整场景"));
    await act(async () =>
      handlersOf(0).onToolResult("start-scene-job", "start-scene-job", undefined, ["scene-job-task"]),
    );
    expect(pollTasks.mock.calls[0]![0]).toEqual(["scene-job-task"]);
    await act(async () => handlersOf(0).onDone());

    const onSettled = pollTasks.mock.calls[0]![1] as (value: unknown) => void;
    await act(async () =>
      onSettled({
        tasks: [{
          id: "scene-job-task",
          workflowId: "scene-job:test",
          projectSlug: "proj-a",
          subject: "完整场景生成",
          status: "succeeded",
        }],
      }),
    );
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(streamChat.mock.calls[1]![4]).toMatchObject({
      resume: {
        kind: "tasks",
        text: expect.stringContaining("[Background tasks finished]"),
      },
    });
    await h.unmount();
  });

  /**
   * 这条是整个改动的核心：不变量住在 startStream 里，不是按钮的 disabled 上。
   * 两条流并发时第二条的历史不含第一条的消息，上下文分叉、回复交错，
   * 而且两边都可能各自调用一次付费生成工具。
   */
  test("流进行中再次 send，不会拉起第二条流", async () => {
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("第一条"));
    expect(streamChat).toHaveBeenCalledTimes(1);

    await act(async () => h.result.current.send("第二条"));
    await act(async () => h.result.current.send("第三条"));
    expect(streamChat).toHaveBeenCalledTimes(1);

    await h.unmount();
  });

  test("上一轮结束后可以正常再发", async () => {
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("第一条"));
    expect(streamChat).toHaveBeenCalledTimes(1);

    await act(async () => handlersOf(0).onDone());
    await act(async () => h.result.current.send("第二条"));
    expect(streamChat).toHaveBeenCalledTimes(2);

    await h.unmount();
  });

  test("思考状态不沉淀为历史工具节点", async () => {
    const { mount, pushMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("第一条"));
    const sent = pushMessage.mock.calls.map(([message]) => message);
    expect(sent).toEqual([
      expect.objectContaining({ role: "user", content: "第一条" }),
      expect.objectContaining({ role: "assistant", content: "" }),
    ]);
    expect(sent[1]?.activities).toBeUndefined();

    await act(async () => handlersOf(0).onDone());
    expect(pushMessage.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({ role: "user", content: "第一条" }),
      expect.objectContaining({ role: "assistant", content: "" }),
    ]);

    await h.unmount();
  });

  test("工具完成事件把对应消息轨迹从播放态改为完成态", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成参考图"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;

    await act(async () => handlersOf(0).onTool("generate-reference-images", "tool-1"));
    const afterTool = updateMessage.mock.calls.at(-1)![1](assistant);
    expect(afterTool.activities).toHaveLength(1);
    expect(afterTool.activities?.at(-1)).toMatchObject({
      id: "tool-1",
      contentOffset: 0,
      label: "Generating image",
      status: "running",
    });

    await act(async () => handlersOf(0).onToolResult("generate-reference-images", "tool-1"));
    const afterResult = updateMessage.mock.calls.at(-1)![1](afterTool);
    expect(afterResult.activities?.at(-1)).toMatchObject({
      id: "tool-1",
      label: "Completed: generating image",
      status: "completed",
    });

    await h.unmount();
  });

  test("流结束但没有工具终态事件时不把调用误报为完成", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成参考图"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;

    await act(async () => handlersOf(0).onTool("generate-reference-images", "tool-1"));
    const afterTool = updateMessage.mock.calls.at(-1)![1](assistant);
    await act(async () => handlersOf(0).onDone());
    const afterDone = updateMessage.mock.calls.at(-1)![1](afterTool);

    expect(afterDone.activities?.at(-1)).toMatchObject({
      id: "tool-1",
      label: "Failed: generating image",
      status: "failed",
    });
    expect(afterDone.agentStatus).toEqual({
      label: "Some steps failed",
      status: "failed",
    });

    await h.unmount();
  });

  test("只读查询工具不进入时间线，避免多出一步 checking", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("进度怎么样"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;
    updateMessage.mockClear();

    await act(async () =>
      handlersOf(0).onTool("list-generation-tasks", "tool-9"),
    );
    expect(updateMessage).not.toHaveBeenCalled();

    // 旧 camelCase 注册名同样按只读查询处理
    await act(async () =>
      handlersOf(0).onTool("listGenerationTasksTool", "tool-10"),
    );
    expect(updateMessage).not.toHaveBeenCalled();

    await act(async () =>
      handlersOf(0).onToolResult("list-generation-tasks", "tool-9"),
    );
    const after = updateMessage.mock.calls.at(-1)![1](assistant);
    expect(after.activities).toBeUndefined();

    await h.unmount();
  });

  test("参考图工具完成时把落盘图片追加到 assistant 消息", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成参考图"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;
    await act(async () => handlersOf(0).onTool("generate-reference-images", "tool-1"));
    const afterTool = updateMessage.mock.calls.at(-1)![1](assistant);

    await act(async () =>
      handlersOf(0).onToolResult("generate-reference-images", "tool-1", [
        "projects/demo/source/0-ref.png",
        "projects/demo/source/0-ref-v2.png",
      ]),
    );
    const afterResult = updateMessage.mock.calls.at(-1)![1](afterTool);
    expect(afterResult.images).toEqual([
      "projects/demo/source/0-ref.png",
      "projects/demo/source/0-ref-v2.png",
    ]);

    await h.unmount();
  });

  test("旧 camelCase 工具名仍显示产品文案而不是内部变量名", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成参考图"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;

    await act(async () => handlersOf(0).onTool("generateReferenceImagesTool", "tool-1"));
    const afterTool = updateMessage.mock.calls.at(-1)![1](assistant);
    expect(afterTool.activities?.at(-1)).toMatchObject({
      toolName: "generate-reference-images",
      label: "Generating image",
      status: "running",
    });

    await act(async () =>
      handlersOf(0).onToolResult("generateReferenceImagesTool", "tool-1"),
    );
    const afterResult = updateMessage.mock.calls.at(-1)![1](afterTool);
    expect(afterResult.activities?.at(-1)).toMatchObject({
      label: "Completed: generating image",
      status: "completed",
    });

    await h.unmount();
  });

  test("连续工具调用记录各自发生时的正文偏移", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成模型"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;
    const intro = "我先生成参考图。";
    const middle = "参考图完成，继续生成模型。";

    await act(async () => handlersOf(0).onDelta(intro));
    await act(async () => handlersOf(0).onTool("generate-reference-images", "tool-1"));
    const afterFirstTool = updateMessage.mock.calls.at(-1)![1](assistant);
    expect(afterFirstTool.activities?.at(-1)?.contentOffset).toBe(intro.length);

    await act(async () => handlersOf(0).onToolResult("generate-reference-images", "tool-1"));
    const afterFirstResult = updateMessage.mock.calls.at(-1)![1](afterFirstTool);
    await act(async () => handlersOf(0).onDelta(middle));
    await act(async () => handlersOf(0).onTool("edit-reference-image", "tool-2"));
    const afterSecondTool = updateMessage.mock.calls.at(-1)![1](afterFirstResult);
    expect(afterSecondTool.activities?.at(-1)?.contentOffset).toBe(
      (intro + middle).length,
    );

    await h.unmount();
  });

  test("生成类工具不进入时间线，但状态行仍然显示正在生成", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("把这只猫生成成 3D 模型"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;

    await act(async () => handlersOf(0).onTool("start-3d-batch", "tool-1"));
    const afterStart = updateMessage.mock.calls.at(-1)![1](assistant);
    // 步骤节点被收起，但状态行还是"在生成"
    expect(afterStart.activities).toBeUndefined();
    expect(afterStart.agentStatus).toEqual({
      label: "Starting 3D generation",
      status: "running",
    });

    // 生成链路上的自检同样不占时间线
    await act(async () => handlersOf(0).onToolResult("start-3d-batch", "tool-1"));
    const afterResult = updateMessage.mock.calls.at(-1)![1](afterStart);
    await act(async () => handlersOf(0).onTool("inspect-asset", "tool-2"));
    const afterInspect = updateMessage.mock.calls.at(-1)![1](afterResult);
    expect(afterInspect.activities).toBeUndefined();

    await h.unmount();
  });

  test("生成类工具失败时仍然落一行失败节点", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("把这只猫生成成 3D 模型"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;

    await act(async () => handlersOf(0).onToolError("start-3d-batch", "tool-1"));
    const afterError = updateMessage.mock.calls.at(-1)![1](assistant);
    expect(afterError.activities).toEqual([
      expect.objectContaining({
        id: "tool-1",
        toolName: "start-3d-batch",
        label: "Failed: starting 3D generation",
        status: "failed",
      }),
    ]);

    await h.unmount();
  });

  test("缺少 tool-call 前置事件时，tool-error 仍补建失败节点", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("构建 CAD"));
    const assistant = pushMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.role === "assistant")!;
    const intro = "我先尝试构建。";
    await act(async () => handlersOf(0).onDelta(intro));
    await act(async () => handlersOf(0).onToolError("build-cad-model", "tool-failed"));

    const afterError = updateMessage.mock.calls.at(-1)![1](assistant);
    expect(afterError.agentStatus).toEqual({
      label: "Thinking",
      status: "running",
    });
    expect(afterError.activities).toEqual([
      expect.objectContaining({
        id: "tool-failed",
        toolName: "build-cad-model",
        contentOffset: intro.length,
        label: "Failed: building CAD model",
        status: "failed",
      }),
    ]);

    await h.unmount();
  });

  test("请求时过滤旧会话遗留的空 assistant 消息", async () => {
    const { mount, messagesRef } = harness();
    messagesRef.current = [
      { id: "old-user", role: "user", content: "上一条" },
      { id: "old-empty", role: "assistant", content: "" },
    ];
    const h = await mount();

    await act(async () => h.result.current.send("继续"));

    expect(streamChat.mock.calls[0]![1]).toEqual([
      { role: "user", content: "上一条" },
      { role: "user", content: "继续" },
    ]);

    await h.unmount();
  });

  test("出错结束后也能再发（不会把输入永久卡死）", async () => {
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("第一条"));
    await act(async () => handlersOf(0).onError("服务炸了"));
    await act(async () => h.result.current.send("第二条"));
    expect(streamChat).toHaveBeenCalledTimes(2);

    await h.unmount();
  });
});

describe("useAgentChat 中止能力", () => {
  test("stopStream 会中止在途请求并解除 streaming", async () => {
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成一把椅子"));
    const signal = signalOf(0);
    expect(signal.aborted).toBe(false);
    expect(h.result.current.streaming).toBe(true);

    await act(async () => h.result.current.stopStream());
    expect(signal.aborted).toBe(true);
    expect(h.result.current.streaming).toBe(false);

    await h.unmount();
  });

  test("停止之后可以立刻重新发起", async () => {
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("第一条"));
    await act(async () => h.result.current.stopStream());
    await act(async () => h.result.current.send("第二条"));
    expect(streamChat).toHaveBeenCalledTimes(2);

    await h.unmount();
  });

  /**
   * 没有这条，离开工作台后读取循环仍会跑到自然结束，并继续往已卸载的组件里
   * 回调 onDelta——与 useTaskPolling 那个泄漏同一类根因。
   */
  test("卸载时中止在途请求", async () => {
    const { mount } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成一把椅子"));
    const signal = signalOf(0);

    await h.unmount();
    expect(signal.aborted).toBe(true);
  });

  /**
   * 用户点停止不等于放弃那些已经在跑、且**会继续在服务端跑完**的参考图生成
   * （2026-10-02 实测：16 张参考图全部落盘、界面上全是"Stopped"、对话里一张没有）。
   * 所以停止之后必须补几次项目状态刷新，让新图自己冒出来；判据是这一轮确实有
   * 图片生成工具没回结果。
   */
  test("中止在途图片生成后补刷新项目状态", async () => {
    const { mount, bumpRefresh } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("提取这张图里的全部家具"));
    await act(async () => handlersOf(0).onTool("generate-reference-images", "tool-1"));
    bumpRefresh.mockClear();

    await act(async () => h.result.current.stopStream());
    // 0ms 那一档必须立刻到：不能等用户下一次操作才发现新图
    await flush();
    expect(bumpRefresh).toHaveBeenCalled();

    await h.unmount();
  });

  test("停止普通生成不会额外刷新图片", async () => {
    const { mount, bumpRefresh } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("生成一把椅子"));
    await act(async () => handlersOf(0).onTool("start-3d-batch", "tool-1"));
    bumpRefresh.mockClear();

    await act(async () => h.result.current.stopStream());
    await flush();
    expect(bumpRefresh).not.toHaveBeenCalled();

    await h.unmount();
  });

  test("图片结果正常回来之后停止，不再补刷新", async () => {
    const { mount, bumpRefresh } = harness();
    const h = await mount();

    await act(async () => h.result.current.send("提取家具"));
    await act(async () => handlersOf(0).onTool("generate-reference-images", "tool-1"));
    await act(async () =>
      handlersOf(0).onToolResult("generate-reference-images", "tool-1", [
        "projects/proj-a/source/0-sofa-ref.png",
      ]),
    );
    bumpRefresh.mockClear();

    await act(async () => h.result.current.stopStream());
    await flush();
    expect(bumpRefresh).not.toHaveBeenCalled();

    await h.unmount();
  });

});

/** 用真实消息 state 覆盖整条链，避免只断言 mock 调用而漏掉恢复和状态竞争。 */
async function liveHarness(ready = true) {
  const { useChatMessages } = await import("./useChatMessages");
  const pollTasks = mock((..._args: unknown[]) => {});
  const h = await renderHook(({ sessionReady, sessionId }) => {
    const chat = useChatMessages();
    const agent = useAgentChat({
      ...chat,
      projectSlug: "proj-a",
      sessionId,
      sessionReady,
      pollTasks: pollTasks as never,
      bumpRefresh: () => {},
    });
    return { ...chat, ...agent };
  }, { sessionReady: ready, sessionId: "session-a" });
  const settle = (call = 0) => {
    const [ids, callback] = pollTasks.mock.calls[call]! as [string[], (value: unknown) => void];
    callback({ tasks: ids.map((id) => ({
      id, workflowId: "3d", projectSlug: "proj-a", subject: "3D 生成：金毛", status: "succeeded",
    })) });
  };
  return { h, pollTasks, settle };
}

describe("生成流程持续执行", () => {
  test("cloud Blender waits without spinning plan turns, then wakes the same conversation to import the existing session", async () => {
    const { h, pollTasks } = await liveHarness();
    await act(async () => h.result.current.send("用 Blender 建模并导入"));
    await act(async () => handlersOf(0).onToolResult("start-blender-batch", "b", undefined, ["blender-session-0"]));
    await act(async () => handlersOf(0).onDone());
    expect(h.result.current.messages.at(-1)?.pendingTaskIds).toEqual(["blender-session-0"]);
    expect(streamChat).toHaveBeenCalledTimes(1);
    const callback = pollTasks.mock.calls[0]![1] as (value: unknown) => void;
    await act(async () => callback({ tasks: [{ id: "blender-session-0", workflowId: "blender-cloud", projectSlug: "proj-a", subject: "Blender: Cube", status: "succeeded", result: { blenderSessionId: "real-session" } }] }));
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(streamChat.mock.calls[1])).toContain("cloud Blender sessionId=real-session");
    expect(JSON.stringify(streamChat.mock.calls[1])).toContain("blender-session-action import");
    await h.unmount();
  });
  /**
   * 真实事故（p-mv3ctr2n）：桌子已经发布了 GLB，任务却以 model_budget_exhausted 收尾。
   * 失败行必须交出会话 id 与"先查已存产物"的口径，否则会话只会建议重新建模、或宣称产物丢了。
   */
  test("失败的 cloud Blender 任务交出会话 id 和已存产物，而不是重新建模", async () => {
    const { h, pollTasks } = await liveHarness();
    await act(async () => h.result.current.send("用 Blender 建模并导入"));
    await act(async () => handlersOf(0).onToolResult("start-blender-batch", "b", undefined, ["blender-session-1"]));
    await act(async () => handlersOf(0).onDone());
    const callback = pollTasks.mock.calls[0]![1] as (value: unknown) => void;
    await act(async () => callback({ tasks: [{ id: "blender-session-1", workflowId: "blender-cloud", projectSlug: "proj-a", subject: "Blender: Table", status: "failed", error: "model_budget_exhausted", result: { blenderSessionId: "real-session" } }] }));
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);
    const resume = JSON.stringify(streamChat.mock.calls[1]);
    expect(resume).toContain("Blender: Table: failed (model_budget_exhausted)");
    expect(resume).toContain("cloud Blender sessionId=real-session");
    expect(resume).toContain("Query blender-session-action status");
    expect(resume).toContain("Do not restart, resume, retry or re-model automatically");
    await h.unmount();
  });
  test("提交后的回复结束仍保持运行，后台完成自动交付后才结束", async () => {
    const { h, settle } = await liveHarness();
    await act(async () => h.result.current.send("生成金毛的模型"));
    await act(async () => handlersOf(0).onToolResult("start-3d-batch", "t", undefined, ["job-1"]));
    await act(async () => handlersOf(0).onDone());
    expect(h.result.current.streaming).toBe(true);
    expect(h.result.current.activity.state).toBe("working");
    expect(h.result.current.messages.at(-1)).toMatchObject({ pendingTaskIds: ["job-1"], agentStatus: { status: "running" } });
    await act(async () => h.result.current.send("重复生成"));
    expect(streamChat).toHaveBeenCalledTimes(1);

    await act(async () => settle());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(h.result.current.streaming).toBe(true);
    expect(h.result.current.messages.some((message) => message.pendingTaskIds?.length)).toBe(false);
    await act(async () => {
      handlersOf(1).onDelta("模型已完成，这是产物路径。");
      handlersOf(1).onDone();
    });
    expect(h.result.current.streaming).toBe(false);
    expect(h.result.current.messages.at(-1)?.content).toContain("模型已完成");
    await h.unmount();
  });

  test("恢复会话后重新跟踪保存的任务，即使任务离线期间已完成也会自动续跑一次", async () => {
    const { h, pollTasks, settle } = await liveHarness(false);
    await act(async () => h.result.current.setMessages([
      { id: "user", role: "user", content: "生成金毛模型" },
      { id: "owner", role: "assistant", content: "正在生成", pendingTaskIds: ["saved-job"] },
    ]));
    expect(pollTasks).not.toHaveBeenCalled();
    await h.rerender({ sessionReady: true, sessionId: "session-a" });
    expect(pollTasks).toHaveBeenCalledTimes(1);
    expect(pollTasks.mock.calls[0]![0]).toEqual(["saved-job"]);
    expect(h.result.current.streaming).toBe(true);
    await h.rerender({ sessionReady: true, sessionId: "session-a" });
    expect(pollTasks).toHaveBeenCalledTimes(1);
    await act(async () => settle());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(streamChat.mock.calls[0]![1]).toEqual([
      { role: "user", content: "生成金毛模型" },
      { role: "assistant", content: "正在生成" },
    ]);
    expect(streamChat.mock.calls[0]![4]).toMatchObject({
      resume: {
        kind: "tasks",
        text: expect.stringContaining("[Background tasks finished]"),
      },
    });
    await h.unmount();
  });

  test("等待期间主动停止，晚到的结果不能重新唤醒或在刷新后继续", async () => {
    const { h, settle } = await liveHarness();
    await act(async () => h.result.current.send("生成模型"));
    await act(async () => handlersOf(0).onToolResult("start-3d-batch", "t", undefined, ["job-1"]));
    await act(async () => handlersOf(0).onDone());
    await act(async () => h.result.current.stopStream());
    expect(h.result.current.streaming).toBe(false);
    expect(h.result.current.messages.some((message) => message.pendingTaskIds?.length)).toBe(false);
    await act(async () => settle());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(1);
    await act(async () => h.result.current.send("新的请求"));
    expect(streamChat).toHaveBeenCalledTimes(2);
    await h.unmount();
  });

  test("完成结果先到、对话流随后出错时，仍然释放完成通知自动继续", async () => {
    const { h, settle } = await liveHarness();
    await act(async () => h.result.current.send("生成模型"));
    await act(async () => handlersOf(0).onToolResult("start-3d-batch", "t", undefined, ["job-1"]));
    await act(async () => settle());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(1);
    await act(async () => handlersOf(0).onError("connection lost after submission"));
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);
    await h.unmount();
  });

  test("自检截图尚未返回时仍在运行，截图上传后自动开启检查轮", async () => {
    const originalFetch = globalThis.fetch;
    const pendingAsset = deferred<Response>();
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ path: "projects/proj-a/assets/dog/check.png" })
        : pendingAsset.promise,
    ) as unknown as typeof fetch;
    const { h } = await liveHarness();
    try {
      await act(async () => h.result.current.send("检查模型"));
      await act(async () => handlersOf(0).onTool("inspect-asset", "inspection-1", { assetSlug: "dog" }));
      await act(async () => handlersOf(0).onDone());
      expect(h.result.current.streaming).toBe(true);
      expect(h.result.current.messages.at(-1)?.pendingInspectionAssetSlug).toBe("dog");
      pendingAsset.resolve(Response.json({
        project: { slug: "proj-a", name: "Test" },
        assets: [{ slug: "dog", files: ["0-dog.glb"] }],
        sources: [],
      }));
      await flush(20);
      expect(h.result.current.preview?.inspection?.id).toBe("inspection-1");
      await act(async () => h.result.current.handleInspectionCaptured("inspection-1", "aGVsbG8="));
      await flush(20);
      expect(streamChat).toHaveBeenCalledTimes(2);
      expect(h.result.current.streaming).toBe(true);
      expect(h.result.current.messages.some((message) => message.pendingInspectionAssetSlug)).toBe(false);
      // 检查图是 Agent 自己的产物：走 resume 交回，不进消息历史、不冒充用户发言
      expect(streamChat.mock.calls[1]![1]).toEqual([
        { role: "user", content: "检查模型" },
      ]);
      expect(streamChat.mock.calls[1]![4]).toMatchObject({
        resume: {
          kind: "inspection",
          text: expect.stringContaining("[Self-check]"),
          images: ["projects/proj-a/assets/dog/check.png"],
        },
      });
      // 界面上它是本轮 assistant 消息上的 Agent 侧卡片
      expect(h.result.current.messages.at(-1)).toMatchObject({
        role: "assistant",
        autoTurn: {
          kind: "inspection",
          label: expect.stringContaining("ISO / FRONT / RIGHT / TOP"),
          images: ["projects/proj-a/assets/dog/check.png"],
        },
      });
      await act(async () => handlersOf(1).onDone());
      expect(h.result.current.streaming).toBe(false);
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * 整场景检查走的是与单模型并列的第二条通道：不开预览小窗，由主视口按机位拍一张，
 * 落盘在**项目级**目录，回到模型眼前的上下文是 [Scene check] 而不是 [Self-check]。
 */
test("整场景检查：主视口按机位截图，落盘项目级目录后走 [Scene check] 续跑", async () => {
  const originalFetch = globalThis.fetch;
  const posted: string[] = [];
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(String(input));
      return Response.json({ path: "projects/proj-a/inspections/scene-1.png" });
    }
    return Response.json({
      project: { slug: "proj-a", name: "Test" },
      assets: [{ slug: "dog", files: ["0-dog.glb"] }],
      sources: [],
    });
  }) as unknown as typeof fetch;
  const { h } = await liveHarness();
  try {
    await act(async () => h.result.current.send("检查一下整个场景"));
    await act(async () =>
      handlersOf(0).onTool("inspect", "scene-1", { target: "scene", views: ["top"] }),
    );
    await act(async () => handlersOf(0).onDone());
    // 场景检查不开小窗：等的是主视口那张图
    expect(h.result.current.preview).toBe(null);
    expect(h.result.current.sceneInspection).toMatchObject({
      id: "scene-1",
      target: "scene",
      views: ["top"],
    });
    expect(h.result.current.streaming).toBe(true);
    expect(h.result.current.messages.at(-1)?.pendingSceneInspectionView).toBe("top");

    await act(async () =>
      h.result.current.handleSceneInspectionCaptured("scene-1", "aGVsbG8="),
    );
    await flush(20);
    // 落盘在项目级端点，而不是某个资产的 inspections 目录
    expect(posted).toEqual(["http://127.0.0.1:3901/api/projects/proj-a/inspection"]);
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(streamChat.mock.calls[1]![4]).toMatchObject({
      resume: {
        kind: "inspection",
        text: expect.stringContaining("[Scene check]"),
        images: ["projects/proj-a/inspections/scene-1.png"],
      },
    });
    expect(h.result.current.messages.some((m) => m.pendingSceneInspectionView)).toBe(false);
    expect(h.result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      autoTurn: {
        kind: "inspection",
        label: expect.stringContaining("Scene check"),
        images: ["projects/proj-a/inspections/scene-1.png"],
      },
    });
    await act(async () => handlersOf(1).onDone());
    expect(h.result.current.streaming).toBe(false);
  } finally {
    await h.unmount();
    globalThis.fetch = originalFetch;
  }
});

/**
 * 贴近检查是与整场景检查并列、但**同一执行者（主视口）**的第三条通道：不开小窗，
 * 相机真的飞到那个模型旁边拍一张，落盘同样在项目级目录，回到模型眼前的上下文是
 * [Close-up check]——并且要明说"再调一次得到的是同一张图"，否则模型会以为能换个角度重试。
 */
test("贴近检查：主视口把相机飞过去拍，落盘项目级目录后走 [Close-up check] 续跑", async () => {
  const originalFetch = globalThis.fetch;
  const posted: string[] = [];
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(String(input));
      return Response.json({ path: "projects/proj-a/inspections/closeup-1.png" });
    }
    return Response.json({
      project: { slug: "proj-a", name: "Test" },
      assets: [{ slug: "dog", files: ["0-dog.glb"] }],
      sources: [],
    });
  }) as unknown as typeof fetch;
  const { h } = await liveHarness();
  try {
    await act(async () => h.result.current.send("看看这只狗摆得对不对"));
    await act(async () =>
      handlersOf(0).onTool("inspect", "closeup-1", { target: "closeup", assetSlug: "dog" }),
    );
    await act(async () => handlersOf(0).onDone());
    // 贴近检查也不开小窗：等的是主视口飞过去拍的那张图
    expect(h.result.current.preview).toBe(null);
    expect(h.result.current.sceneInspection).toMatchObject({
      id: "closeup-1",
      target: "closeup",
      assetSlug: "dog",
    });
    // 恢复会话靠这个字段把相机再飞一次（与整场景检查的机位字段并列）
    expect(h.result.current.messages.at(-1)?.pendingCloseupAssetSlug).toBe("dog");

    await act(async () =>
      h.result.current.handleSceneInspectionCaptured("closeup-1", "aGVsbG8="),
    );
    await flush(20);
    expect(posted).toEqual(["http://127.0.0.1:3901/api/projects/proj-a/inspection"]);
    expect(streamChat).toHaveBeenCalledTimes(2);
    const resume = streamChat.mock.calls[1]![4] as {
      resume: { kind: string; text: string; images: string[] };
    };
    // 逐项断言而不是 toMatchObject + 不对称匹配器：bun 会把匹配器**写回**被匹配对象，
    // 之后同一处再读就只剩一个 ExpectStringContaining（这条踩过）。
    expect(resume.resume.kind).toBe("inspection");
    expect(resume.resume.images).toEqual(["projects/proj-a/inspections/closeup-1.png"]);
    expect(resume.resume.text).toContain("[Close-up check]");
    // 机位由摆放决定：必须写明重复调用是同一张，别让它空转三轮
    expect(resume.resume.text).toContain("the same shot");
    expect(h.result.current.messages.some((m) => m.pendingCloseupAssetSlug)).toBe(false);
    expect(h.result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      autoTurn: {
        kind: "inspection",
        label: expect.stringContaining("Close-up check"),
        images: ["projects/proj-a/inspections/closeup-1.png"],
      },
    });
    await act(async () => handlersOf(1).onDone());
    expect(h.result.current.streaming).toBe(false);
  } finally {
    await h.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("恢复保存的自检，截图失败时解除等待并明确报错", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => Response.json({
    project: { slug: "proj-a", name: "Test" }, sources: [],
    assets: [{ slug: "dog", files: ["0-dog.glb"] }],
  })) as unknown as typeof fetch;
  const { h } = await liveHarness(false);
  try {
    await act(async () => h.result.current.setMessages([
      { id: "inspection", role: "assistant", content: "检查模型", pendingInspectionAssetSlug: "dog" },
    ]));
    await h.rerender({ sessionReady: true, sessionId: "session-a" });
    await flush(20);
    expect(h.result.current.streaming).toBe(true);
    const id = h.result.current.preview?.inspection?.id;
    expect(id).toBeDefined();
    await act(async () => h.result.current.handleInspectionCaptured(id!, null));
    expect(h.result.current.streaming).toBe(false);
    expect(h.result.current.activity.state).toBe("attention");
    expect(h.result.current.messages.some((message) => message.pendingInspectionAssetSlug)).toBe(false);
    expect(streamChat).not.toHaveBeenCalled();
  } finally {
    await h.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("关闭自检预览不会留下无法完成的等待状态", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => Response.json({
    project: { slug: "proj-a", name: "Test" }, sources: [],
    assets: [{ slug: "dog", files: ["0-dog.glb"] }],
  })) as unknown as typeof fetch;
  const { h } = await liveHarness();
  try {
    await act(async () => h.result.current.send("检查模型"));
    await act(async () => handlersOf(0).onTool("inspect-asset", "inspection", { assetSlug: "dog" }));
    await act(async () => handlersOf(0).onDone());
    await flush(20);
    expect(h.result.current.streaming).toBe(true);
    await act(async () => h.result.current.closePreview());
    expect(h.result.current.streaming).toBe(false);
    expect(h.result.current.preview).toBeNull();
    expect(h.result.current.messages.at(-1)?.content).toContain("preview was closed");
  } finally {
    await h.unmount();
    globalThis.fetch = originalFetch;
  }
});

const QUESTION: AskUserQuestion = {
  questionId: "q-1",
  header: "付费确认",
  question: "是否按上述计划生成？",
  details: ["Seedream 生成参考图 1 张"],
  options: [
    { id: "approve", label: "同意", recommended: true },
    { id: "stop", label: "停止", tone: "danger" },
  ],
  multiSelect: false,
  allowOther: false,
};

const ANSWER: AskUserAnswer = {
  questionId: "q-1",
  question: QUESTION.question,
  optionIds: ["approve"],
  labels: ["同意"],
};

const assistantOf = (pushMessage: ReturnType<typeof harness>["pushMessage"]) =>
  pushMessage.mock.calls
    .map(([message]) => message)
    .find((message) => message.role === "assistant")!;

/** 按顺序重放某条消息上已发生的 updateMessage，得到它此刻的样子 */
function replay(
  updateMessage: ReturnType<typeof harness>["updateMessage"],
  base: ChatMessage,
) {
  return updateMessage.mock.calls.reduce(
    (message, call) => (call[0] === base.id ? call[1](message) : message),
    base,
  );
}

describe("ask-user 提问卡片", () => {
  test("提问事件把卡片挂到本轮消息上，流结束后状态是等你决定而不是完成", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成椅子"));
    const assistant = assistantOf(pushMessage);

    await act(async () => handlersOf(0).onTool("ask-user", "tool-q"));
    await act(async () =>
      handlersOf(0).onToolResult("ask-user", "tool-q", undefined, undefined, undefined, QUESTION),
    );
    const withCard = replay(updateMessage, assistant);
    expect(withCard.pendingQuestion).toEqual(QUESTION);
    expect(withCard.agentStatus).toEqual({
      label: "Waiting for your decision",
      status: "waiting",
    });

    // 服务端提问后会中止本轮，客户端看到的是正常 done——不能当成"干完了"
    await act(async () => handlersOf(0).onDone());
    expect(replay(updateMessage, assistant).agentStatus).toEqual({
      label: "Waiting for your decision",
      status: "waiting",
    });
    // 等待回答不是"流在跑"，输入框必须保持可用
    expect(h.result.current.streaming).toBe(false);

    await h.unmount();
  });

  test("点选卡片只更新卡片并续跑：不往历史里推用户消息", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成椅子"));
    const assistant = assistantOf(pushMessage);
    await act(async () =>
      handlersOf(0).onToolResult("ask-user", "tool-q", undefined, undefined, undefined, QUESTION),
    );
    await act(async () => handlersOf(0).onDone());
    pushMessage.mockClear();

    await act(async () => h.result.current.answerQuestion(assistant.id, ANSWER));

    // 卡片转成只读回执
    const receipt = replay(updateMessage, assistant);
    expect(receipt.questionAnswer).toEqual(ANSWER);
    expect(receipt.pendingQuestion).toEqual(QUESTION);

    // 推给界面的只有新一轮的 assistant 占位气泡，没有"用户发了条消息"
    expect(
      pushMessage.mock.calls.map(([message]) => message).filter((m) => m.role === "user"),
    ).toEqual([]);

    // 回答走请求顶层字段，不混进 messages
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(streamChat.mock.calls[1]![1]).toEqual([]);
    expect(streamChat.mock.calls[1]![4]).toMatchObject({ answer: ANSWER });

    await h.unmount();
  });

  test("用户不点卡片直接打字：提问标成已忽略，卡片本身仍留在历史里", async () => {
    const { mount, pushMessage, updateMessage, messagesRef } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成椅子"));
    const assistant = assistantOf(pushMessage);
    await act(async () =>
      handlersOf(0).onToolResult("ask-user", "tool-q", undefined, undefined, undefined, QUESTION),
    );
    await act(async () => handlersOf(0).onDone());
    const withCard = replay(updateMessage, assistant);

    messagesRef.current = [withCard];
    updateMessage.mockClear();
    await act(async () => h.result.current.send("算了，先只生成参考图"));

    const superseded = replay(updateMessage, withCard);
    expect(superseded.supersededQuestion).toBe(true);
    expect(superseded.pendingQuestion).toEqual(QUESTION);

    // 直接打字同样要接着跑，且新消息不带 answer 部件
    expect(streamChat).toHaveBeenCalledTimes(2);
    const history = streamChat.mock.calls[1]![1] as OutgoingChatMessage[];
    expect(history.at(-1)?.content).toBe("算了，先只生成参考图");

    await h.unmount();
  });

  test("换会话后不再认为本轮停在提问上", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount("proj-a");
    await act(async () => h.result.current.send("生成椅子"));
    const assistant = assistantOf(pushMessage);
    await act(async () =>
      handlersOf(0).onToolResult("ask-user", "tool-q", undefined, undefined, undefined, QUESTION),
    );

    await act(async () => h.rerender("proj-b"));
    await act(async () => handlersOf(0).onDone());

    expect(replay(updateMessage, assistant).agentStatus).toEqual({
      label: "Completed",
      status: "completed",
    });

    await h.unmount();
  });
});

/**
 * 提问未决期间，所有自动续跑都必须原地等——这是"我没回答它自己往下做"的唯一硬闸门。
 * 服务端在 ask-user 之后会主动中止本轮，所以本轮结束时流是正常结束的；如果只看
 * "流结束了"，后台任务收尾、自检图上传都会把 Agent 立刻拉起来。
 */
describe("ask-user 未回答时闸住自动续跑", () => {
  test("后台任务完成也先留在队里，用户回答后才交回模型", async () => {
    const { mount, pushMessage, pollTasks } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成椅子并继续完成计划"));
    await act(async () =>
      handlersOf(0).onToolResult("start-3d-batch", "tool-task", undefined, ["task-1"]),
    );
    await act(async () =>
      handlersOf(0).onToolResult("ask-user", "tool-q", undefined, undefined, undefined, QUESTION),
    );
    await act(async () => handlersOf(0).onDone());

    const onSettled = pollTasks.mock.calls[0]![1] as (value: unknown) => void;
    await act(async () =>
      onSettled({
        tasks: [{
          id: "task-1",
          workflowId: "3d",
          projectSlug: "proj-a",
          subject: "3D 生成：椅子",
          status: "succeeded",
        }],
      }),
    );
    await flush(20);

    // 问题还挂着：任务完成通知不许把 Agent 拉起来
    expect(streamChat).toHaveBeenCalledTimes(1);

    // 而且此时用户仍然能点卡片作答——不能因为后台任务在跑就锁死在死局里
    const assistant = assistantOf(pushMessage);
    await act(async () => h.result.current.answerQuestion(assistant.id, ANSWER));
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(streamChat.mock.calls[1]![4]).toMatchObject({ answer: ANSWER });

    // 回答这一轮结束后，排队等着的任务结果才交回去
    await act(async () => handlersOf(1).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(3);
    expect(streamChat.mock.calls[2]![4]).toMatchObject({
      resume: { kind: "tasks", text: expect.stringContaining("[Background tasks finished]") },
    });

    await h.unmount();
  });

  test("自检截图上传完也不会续跑：问题没答完，Agent 不拿图继续", async () => {
    const originalFetch = globalThis.fetch;
    const pendingAsset = deferred<Response>();
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ path: "projects/proj-a/assets/dog/check.png" })
        : pendingAsset.promise,
    ) as unknown as typeof fetch;
    const { h } = await liveHarness();
    try {
      await act(async () => h.result.current.send("检查模型"));
      await act(async () => handlersOf(0).onTool("inspect-asset", "inspection-1", { assetSlug: "dog" }));
      await act(async () =>
        handlersOf(0).onToolResult("ask-user", "tool-q", undefined, undefined, undefined, QUESTION),
      );
      await act(async () => handlersOf(0).onDone());
      pendingAsset.resolve(Response.json({
        project: { slug: "proj-a", name: "Test" },
        assets: [{ slug: "dog", files: ["0-dog.glb"] }],
        sources: [],
      }));
      await flush(20);
      expect(h.result.current.preview?.inspection?.id).toBe("inspection-1");

      await act(async () => h.result.current.handleInspectionCaptured("inspection-1", "aGVsbG8="));
      await flush(20);

      // 截图在队里等，没有开第二条流；卡片仍然可点
      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(
        h.result.current.messages.some(
          (message) => message.pendingQuestion && !message.questionAnswer,
        ),
      ).toBe(true);
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * 计划跨多轮执行：模型做完一步、回一句就结束本轮，此时没有任何排队工作，
 * 界面会落回"发送"。这些用例守住"还有没做完的步骤就自己接着做"，
 * 以及不能让它在原地打转时无休止地烧 token。
 */
describe("计划续跑", () => {
  const STEP_PLAN: ProjectPlan = {
    schemaVersion: 1,
    revision: 1,
    title: "生成完整场景",
    steps: [
      { id: "ref", content: "生成参考图", status: "completed" },
      { id: "model", content: "生成模型", status: "in_progress" },
      { id: "world", content: "生成世界", status: "pending" },
    ],
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
  const ADVANCED_PLAN: ProjectPlan = {
    ...STEP_PLAN,
    steps: [
      { id: "ref", content: "生成参考图", status: "completed" },
      { id: "model", content: "生成模型", status: "completed" },
      { id: "world", content: "生成世界", status: "in_progress" },
    ],
    updatedAt: "2026-08-09T00:10:00.000Z",
  };

  test("还有未完成步骤：流结束后自动续跑，并把下一步交给模型", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成完整场景"));
    const assistant = assistantOf(pushMessage);
    await act(async () =>
      handlersOf(0).onToolResult("update-plan", "tool-plan", undefined, undefined, STEP_PLAN),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);

    expect(streamChat).toHaveBeenCalledTimes(2);
    /*
      先把这一轮的 options 取出来再断言：`toMatchObject` 遇到
      `expect.stringContaining` 会把匹配到的字段**写回**接收对象（bun 的
      asymmetric matcher 行为），之后再读到的就不是原字符串了。
    */
    const turn = streamChat.mock.calls[1]![4] as {
      resume: { kind: string; text: string };
    };
    expect(turn.resume.kind).toBe("plan");
    expect(turn.resume.text).toContain("[Plan continues]");
    // 续跑指令里点名下一步，模型不用自己猜从哪继续
    expect(turn.resume.text).toContain("Next up: model");
    // 界面上仍然是 Agent 侧卡片，不是用户消息
    expect(pushMessage.mock.calls.at(-1)![0]).toMatchObject({
      role: "assistant",
      autoTurn: { kind: "plan", label: "Continuing plan · 1/3 steps done" },
    });
    expect(replay(updateMessage, assistant).agentStatus).toMatchObject({
      label: "Continuing plan",
      status: "running",
    });

    await h.unmount();
  });

  test("计划全部完成：不再续跑，收尾状态就是完成", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成完整场景"));
    const assistant = assistantOf(pushMessage);
    await act(async () =>
      handlersOf(0).onToolResult("update-plan", "tool-plan", undefined, undefined, {
        ...STEP_PLAN,
        steps: STEP_PLAN.steps.map((step) => ({ ...step, status: "completed" as const })),
      }),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(replay(updateMessage, assistant).agentStatus).toEqual({
      label: "Completed",
      status: "completed",
    });

    await h.unmount();
  });

  test("某一步失败时不再自动续跑：方向交回用户，不默默重跑", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成完整场景"));
    const assistant = assistantOf(pushMessage);
    await act(async () => handlersOf(0).onTool("generate-reference-images", "tool-gen"));
    await act(async () => handlersOf(0).onToolError("generate-reference-images", "tool-gen"));
    await act(async () =>
      handlersOf(0).onToolResult("update-plan", "tool-plan", undefined, undefined, STEP_PLAN),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);

    // 计划还没做完，但这一步失败了：不自动开下一轮，状态停在失败上
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(replay(updateMessage, assistant).agentStatus).toMatchObject({
      label: "Some steps failed",
      status: "failed",
    });

    await h.unmount();
  });

  test("计划在推进就一直跑，连续两轮没推进才停下来等用户", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成完整场景"));
    await act(async () =>
      handlersOf(0).onToolResult("update-plan", "tool-plan", undefined, undefined, STEP_PLAN),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);

    // 第 1 轮计划续跑：这一步真的推进了计划 → 计数清零，继续
    await act(async () =>
      handlersOf(1).onToolResult("update-plan", "tool-plan-2", undefined, undefined, ADVANCED_PLAN),
    );
    await act(async () => handlersOf(1).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(3);

    // 第 2 轮原地不动 → 停滞 1
    await act(async () => handlersOf(2).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(4);

    // 第 3 轮还是不动 → 停滞 2，到达上限：停下来等用户，不再自己开流
    const lastAssistant = pushMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.role === "assistant")
      .at(-1)!;
    await act(async () => handlersOf(3).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(4);
    expect(replay(updateMessage, lastAssistant).agentStatus).toEqual({
      label: "Plan paused; unfinished steps remain",
      status: "completed",
    });

    await h.unmount();
  });

  /**
   * 2026-10-02 用户报的正是这一条：参考图生成完那一轮，模型想把计划标题改名，
   * 普通进度更新被 update-plan 拒绝；记账失败被当成"这一步失败了"，计划续跑让行，
   * 于是再没有任何东西把 Agent 拉起来，用户被留在正文的「告诉我方向对不对」上，
   * 只能手打一句「继续」才看到那张 3D 同意卡片。
   */
  test("update-plan 自己失败只是记账失败：计划照旧续跑，用户不用手打「继续」", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成完整场景"));
    const assistant = assistantOf(pushMessage);
    await act(async () => handlersOf(0).onTool("update-plan", "tool-plan"));
    await act(async () => handlersOf(0).onToolError("update-plan", "tool-plan"));
    await act(async () =>
      handlersOf(0).onToolResult("update-plan", "tool-plan-2", undefined, undefined, STEP_PLAN),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);

    expect(streamChat).toHaveBeenCalledTimes(2);
    const turn = streamChat.mock.calls[1]![4] as {
      resume: { kind: string; text: string };
    };
    expect(turn.resume.kind).toBe("plan");
    // 续跑指令里点名"要用户拍板就用卡片，不许用正文让他手打一句"
    expect(turn.resume.text).toContain("ask-user");
    expect(turn.resume.text).toContain("Never end this turn by asking the user in prose");
    expect(replay(updateMessage, assistant).agentStatus).toMatchObject({
      label: "Continuing plan",
      status: "running",
    });

    await h.unmount();
  });
});

/**
 * 图片落盘即自动续跑：generate-reference-images 的结果要求模型"这一轮到此为止"，
 * 工作台只会把图贴进对话——过去没有任何事件能把 Agent 拉起来，于是"要不要继续做 3D"
 * 全靠用户在正文里看到一句「告诉我方向对不对」再手打「继续」。
 */
describe("图片落盘自动续跑", () => {
  const REF_PATH = "projects/demo/source/0-chair-ref.jpg";

  test("参考图落盘后自动续跑：新图交回模型，并要它用卡片问下一步", async () => {
    const { mount, pushMessage, updateMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("创建一把椅子模型"));
    const assistant = assistantOf(pushMessage);
    await act(async () => handlersOf(0).onTool("generate-reference-images", "tool-img"));
    await act(async () =>
      handlersOf(0).onToolResult("generate-reference-images", "tool-img", [REF_PATH]),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);

    expect(streamChat).toHaveBeenCalledTimes(2);
    const turn = streamChat.mock.calls[1]![4] as {
      resume: { kind: string; text: string; images?: string[] };
    };
    expect(turn.resume.kind).toBe("reference");
    // 图要真的回到模型眼前：历史里的 assistant 图片不回放（chatService 只发文本部件）
    expect(turn.resume.images).toEqual([REF_PATH]);
    // 这一轮的用途就是把决定交给用户：点名 ask-user，并明确禁止"让用户手打回复"
    expect(turn.resume.text).toContain("ask-user");
    expect(turn.resume.text).toContain("Never ask the user to reply with text");
    // 界面上仍是 Agent 侧卡片；图已经在上面那条气泡里，卡片不重复渲染一遍
    const resumed = pushMessage.mock.calls.at(-1)![0];
    expect(resumed).toMatchObject({
      role: "assistant",
      autoTurn: { kind: "reference", label: "Reference image ready" },
    });
    expect(resumed.autoTurn?.images).toBeUndefined();
    // 落盘的图仍然挂在本轮那条 assistant 消息上
    expect(replay(updateMessage, assistant).images).toEqual([REF_PATH]);

    await h.unmount();
  });

  test("提问未决时图片续跑留在队里，用户答完卡片才交回模型", async () => {
    const { mount, pushMessage } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("创建一把椅子模型"));
    const assistant = assistantOf(pushMessage);
    await act(async () =>
      handlersOf(0).onToolResult("generate-reference-images", "tool-img", [REF_PATH]),
    );
    // 同一轮里模型还弹了一张卡片（服务端随后中止本轮）：先答卡片，不能让图绕过去
    await act(async () =>
      handlersOf(0).onToolResult("ask-user", "tool-q", undefined, undefined, undefined, QUESTION),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(1);

    await act(async () => h.result.current.answerQuestion(assistant.id, ANSWER));
    await flush(20);
    // 回答本身开了第 2 条流；它的 onDone 才把排队的图交回去（第 3 条）
    expect(streamChat).toHaveBeenCalledTimes(2);
    await act(async () => handlersOf(1).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(3);
    const turn = streamChat.mock.calls[2]![4] as {
      resume?: { kind: string; images?: string[] };
    };
    expect(turn.resume?.kind).toBe("reference");
    expect(turn.resume?.images).toEqual([REF_PATH]);

    await h.unmount();
  });

  /**
   * 一轮批量出图（实测 8~16 张）如果全量内联成 data URI，请求体会到十几 MB——
   * 那正是这条自动续跑最容易变成一条报错的地方。超过上限就只带路径：
   * 用户在对话里看得到每一张，模型要确认的是"这一批"。
   */
  test("一批参考图超过上限时续跑只带路径，不把几十 MB 塞进请求", async () => {
    const { mount, pushMessage } = harness();
    const h = await mount();
    const batch = Array.from(
      { length: 6 },
      (_, index) => `projects/demo/source/${index}-part-ref.jpg`,
    );
    await act(async () => h.result.current.send("拆出这组家具"));
    await act(async () =>
      handlersOf(0).onToolResult("generate-reference-images", "tool-img", batch),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);

    expect(streamChat).toHaveBeenCalledTimes(2);
    const turn = streamChat.mock.calls[1]![4] as {
      resume: { kind: string; text: string; images?: string[] };
    };
    expect(turn.resume.kind).toBe("reference");
    expect(turn.resume.images).toBeUndefined();
    // 路径与张数仍然如实写在指令里，模型点得出名
    expect(turn.resume.text).toContain("6 new reference images");
    expect(turn.resume.text).toContain(batch.at(-1)!);
    expect(pushMessage.mock.calls.at(-1)![0]).toMatchObject({
      autoTurn: { kind: "reference", label: "Reference images ready" },
    });

    await h.unmount();
  });

  test("自动续跑那一轮又落盘新图时不再自动跟：一次出图只带一轮自动跟进", async () => {
    const { mount } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("创建一把椅子模型"));
    await act(async () =>
      handlersOf(0).onToolResult("generate-reference-images", "tool-img", [REF_PATH]),
    );
    await act(async () => handlersOf(0).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);

    // 第 2 条流就是图片续跑本身：它又出了图，也不该再无人值守地自动跟一轮
    await act(async () =>
      handlersOf(1).onToolResult("generate-reference-images", "tool-img-2", [
        "projects/demo/source/1-chair-ref.jpg",
      ]),
    );
    await act(async () => handlersOf(1).onDone());
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);

    await h.unmount();
  });
});
