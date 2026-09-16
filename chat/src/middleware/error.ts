import type { Context } from "hono";
import { ZodError } from "zod";
import { ChatServiceError, toErrorMessage } from "../common/errors";

export function errorHandler(err: Error, c: Context) {
  if (err instanceof ChatServiceError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: "validation_error",
          message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      },
      400,
    );
  }
  // 路由里 c.req.json() 对非法 JSON 抛 SyntaxError；契约上这是客户端输入错误，归 400
  // 而非 500（否则坏 JSON 会落到兜底打印完整堆栈）。
  if (err instanceof SyntaxError) {
    return c.json(
      { error: { code: "validation_error", message: "请求体不是合法 JSON" } },
      400,
    );
  }
  console.error("[chat] unhandled error:", err);
  return c.json({ error: { code: "internal_error", message: toErrorMessage(err) } }, 500);
}
