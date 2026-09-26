import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { deferred, flush, renderHook } from "../../test-utils";
import type { ProjectPlan } from "../../shared/lib/libraryApi";
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
          bumpRefresh: () => {},
          sessionPlan: null,
          onPlanUpdated,
        }),
      slug,
    );
  return {
    messagesRef,
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
      provider: undefined,
      baseUrl: undefined,
      model: undefined,
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
      provider: undefined,
      baseUrl: undefined,
      model: undefined,
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
    expect(streamChat.mock.calls[1]![1]).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("[Background tasks finished]"),
      }),
    ]);
    await h.unmount();
  });

  test("one-shot-scene Workflow 的总任务完成后自动继续会话", async () => {
    const { mount, pollTasks } = harness();
    const h = await mount();
    await act(async () => h.result.current.send("生成完整场景"));
    await act(async () =>
      handlersOf(0).onToolResult("workflow-one-shot-scene", "workflow-one-shot", undefined, ["one-shot-task"]),
    );
    expect(pollTasks.mock.calls[0]![0]).toEqual(["one-shot-task"]);
    await act(async () => handlersOf(0).onDone());

    const onSettled = pollTasks.mock.calls[0]![1] as (value: unknown) => void;
    await act(async () =>
      onSettled({
        tasks: [{
          id: "one-shot-task",
          workflowId: "one-shot",
          projectSlug: "proj-a",
          subject: "完整场景生成",
          status: "succeeded",
        }],
      }),
    );
    await flush(20);
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(streamChat.mock.calls[1]![1]).toEqual([
      expect.objectContaining({ content: expect.stringContaining("[Background tasks finished]") }),
    ]);
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
    expect(streamChat.mock.calls[0]![1]).toEqual(expect.arrayContaining([
      { role: "user", content: "生成金毛模型" },
      expect.objectContaining({ content: expect.stringContaining("[Background tasks finished]") }),
    ]));
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
      await act(async () => handlersOf(1).onDone());
      expect(h.result.current.streaming).toBe(false);
    } finally {
      await h.unmount();
      globalThis.fetch = originalFetch;
    }
  });
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
