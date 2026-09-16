import { expect, test } from "bun:test";
import { createApp } from "./app";

test("拒绝未授权网页读取本机项目", async () => {
  const response = await createApp().request("/api/projects", {
    headers: { Origin: "https://untrusted.example" },
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: { message: "不允许此网页访问本机 Gabo 服务" },
  });
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("允许本机开发页面连接服务", async () => {
  const response = await createApp().request("/api/health", {
    headers: { Origin: "http://localhost:5173" },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
});

test("旧 3D 供应商不能从本机任务入口启动", async () => {
  const response = await createApp().request("/api/tasks/3d", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectSlug: "demo", provider: "hyper3d-direct", hyper3dApiKey: "from-browser" }),
  });

  expect(response.status).toBe(400);
});
