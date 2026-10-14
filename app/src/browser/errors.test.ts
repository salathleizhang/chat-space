import { expect, test } from "bun:test";
import { browserErrorMessage } from "./errors";

test("网站缺少供应商凭据应指向网站管理员，覆盖工具与后台任务的中英文错误", () => {
  for (const message of [
    "本机 chat/.env 未配置 WORLDLABS_KEY",
    "WORLDLABS_KEY is not configured in the local chat/.env",
    "Full scene generation requires WORLDLABS_KEY to be configured in the local chat/.env",
  ]) {
    expect(browserErrorMessage(new Error(message))).toBe("该网站尚未配置 World Labs（WORLDLABS_KEY），需要网站管理员启用服务。");
  }
  expect(browserErrorMessage(new Error("本机 chat/.env 未配置 TRIPO_KEY"))).toContain("Tripo3D");
});

test("不改写模型与网络错误的真实原因", () => {
  expect(browserErrorMessage(new Error("missing mesh"))).toBe("missing mesh");
  expect(browserErrorMessage("503 upstream unavailable")).toBe("503 upstream unavailable");
});
