import { describe, expect, test } from "bun:test";
import { startChatHeartbeat } from "./chat";

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
