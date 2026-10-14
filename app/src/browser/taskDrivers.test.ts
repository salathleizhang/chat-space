import { expect, test } from "bun:test";
import { browserTaskDriverIds } from "./taskDrivers";

test("供应商查询间释放 Worker 后，持久化的后续查询仍有驱动", () => {
  expect([...browserTaskDriverIds([
    { task: { id: "waiting" }, nextAt: 115_000 },
    { task: { id: "due" }, nextAt: 99_000 },
  ], [], 100_000)]).toEqual(["waiting", "due"]);
});

test("已结算、丢失调度或到期超过告警窗口的任务不伪装成健康", () => {
  expect(browserTaskDriverIds([
    { task: { id: "finished" }, nextAt: 115_000, done: true },
    { task: { id: "stalled" }, nextAt: 9_999 },
    { task: { id: "invalid" }, nextAt: NaN },
  ], ["chatspace:file:project.json"], 100_000).size).toBe(0);
});

test("正在查询或下载的真实 Worker 锁继续算作驱动", () => {
  expect([...browserTaskDriverIds([
    { task: { id: "downloading" }, nextAt: 0 },
  ], ["chatspace:job:downloading", "chatspace:job:other"], 100_000)])
    .toEqual(["downloading", "other"]);
});
