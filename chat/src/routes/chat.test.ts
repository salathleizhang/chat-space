import { describe, expect, test } from "bun:test";
import { endsAgentTurn, startChatHeartbeat } from "./chat";

describe("ask-user 提问后的硬停", () => {
  const QUESTION = {
    questionId: "q-1",
    question: "是否继续？",
    options: [{ id: "approve", label: "同意" }],
    multiSelect: false,
    allowOther: false,
  };

  test("带提问的 tool-result 结束本轮，其他增量都不结束", () => {
    expect(
      endsAgentTurn({ type: "tool-result", name: "ask-user", question: QUESTION }),
    ).toBe(true);
    expect(endsAgentTurn({ type: "tool-result", name: "start-3d-batch" })).toBe(false);
    expect(endsAgentTurn({ type: "tool", name: "ask-user" })).toBe(false);
    expect(endsAgentTurn({ type: "text", text: "正在生成" })).toBe(false);
  });
});

describe("chat SSE heartbeat", () => {
  test("定期写标准 SSE 注释，停止后不再写入", async () => {
    const writes: string[] = [];
    const stream = {
      aborted: false,
      closed: false,
      async write(input: string) {
        writes.push(input);
      },
    };
    const stop = startChatHeartbeat(stream, 5);

    await Bun.sleep(18);
    stop();
    const countAfterStop = writes.length;
    await Bun.sleep(10);

    expect(countAfterStop).toBeGreaterThanOrEqual(1);
    expect(writes).toEqual(Array(countAfterStop).fill(": keep-alive\n\n"));
    expect(writes).toHaveLength(countAfterStop);
  });

  test("流关闭后不再写心跳", async () => {
    const writes: string[] = [];
    const stream = {
      aborted: false,
      closed: true,
      async write(input: string) {
        writes.push(input);
      },
    };
    const stop = startChatHeartbeat(stream, 5);

    await Bun.sleep(12);
    stop();

    expect(writes).toEqual([]);
  });
});
