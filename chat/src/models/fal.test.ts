import { describe, expect, test } from "bun:test";
import { ChatServiceError } from "../common/errors";
import { callFalQueue, extractFileRefs, uploadToFalStorage } from "./fal";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 模拟 FAL 队列：submit → status（先排队后完成）→ result */
function makeFakeFalFetch(options?: { failSubmit?: boolean; failedStatus?: boolean }) {
  let statusCalls = 0;
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/status")) {
      statusCalls += 1;
      if (options?.failedStatus) {
        return jsonResponse({ status: "COMPLETED", error: "content rejected" });
      }
      return jsonResponse({ status: statusCalls < 2 ? "IN_QUEUE" : "COMPLETED" });
    }
    if (url.includes("/requests/")) {
      return jsonResponse({
        images: [{ url: "https://cdn.fal.ai/out.png", content_type: "image/png" }],
      });
    }
    if (options?.failSubmit) {
      return jsonResponse({ detail: "invalid key" }, 401);
    }
    return jsonResponse({ request_id: "req-1" });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("callFalQueue", () => {
  test("submit → poll → result 全链路", async () => {
    const { fetchFn, calls } = makeFakeFalFetch();
    const statuses: string[] = [];
    const { submission, result } = await callFalQueue(
      "fal-ai/nano-banana-2/edit",
      { prompt: "x" },
      { apiKey: "k", fetchFn, pollIntervalMs: 1, onStatus: (s) => void statuses.push(s) },
    );
    expect(submission.requestId).toBe("req-1");
    expect(statuses).toEqual(["IN_QUEUE", "COMPLETED"]);
    expect(extractFileRefs(result)[0]?.url).toBe("https://cdn.fal.ai/out.png");
    expect(calls[0]).toBe("https://queue.fal.run/fal-ai/nano-banana-2/edit");
  });

  test("提交失败抛 fal_submit_failed", async () => {
    const { fetchFn } = makeFakeFalFetch({ failSubmit: true });
    expect(
      callFalQueue("e/p", {}, { apiKey: "bad", fetchFn, pollIntervalMs: 1 }),
    ).rejects.toThrow(ChatServiceError);
  });

  test("COMPLETED 携带 error 时抛 fal_request_failed", async () => {
    const { fetchFn } = makeFakeFalFetch({ failedStatus: true });
    expect(
      callFalQueue("e/p", {}, { apiKey: "k", fetchFn, pollIntervalMs: 1 }),
    ).rejects.toThrow("FAL 请求失败");
  });
});

describe("uploadToFalStorage", () => {
  test("initiate → PUT → 返回 file_url", async () => {
    const calls: { url: string; method: string; contentType?: string }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        contentType: (init?.headers as Record<string, string>)?.["Content-Type"],
      });
      if (url.includes("/storage/upload/initiate")) {
        return jsonResponse({ upload_url: "https://up.fal/x", file_url: "https://cdn.fal/x.glb" });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const url = await uploadToFalStorage(
      "crate.glb",
      "model/gltf-binary",
      new Uint8Array([1, 2, 3]),
      { apiKey: "k", fetchFn },
    );
    expect(url).toBe("https://cdn.fal/x.glb");
    expect(calls[0]?.url).toBe(
      "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
    );
    expect(calls[1]).toMatchObject({
      url: "https://up.fal/x",
      method: "PUT",
      contentType: "model/gltf-binary",
    });
  });

  test("initiate 失败抛 fal_upload_failed", () => {
    const fetchFn = (async () => jsonResponse({ detail: "bad key" }, 401)) as unknown as typeof fetch;
    expect(
      uploadToFalStorage("a.glb", "model/gltf-binary", new Uint8Array([1]), {
        apiKey: "bad",
        fetchFn,
      }),
    ).rejects.toThrow("fal 存储上传初始化失败");
  });
});

describe("extractFileRefs", () => {
  test("递归提取嵌套文件引用，忽略非 URL", () => {
    const refs = extractFileRefs({
      images: [{ url: "https://a/x.png", content_type: "image/png" }],
      nested: { file: { url: "https://a/y.glb", file_name: "y.glb" } },
      note: { url: "not-a-url" },
    });
    expect(refs.map((r) => r.url)).toEqual(["https://a/x.png", "https://a/y.glb"]);
  });
});
