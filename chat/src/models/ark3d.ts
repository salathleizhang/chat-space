import { ChatServiceError } from "../common/errors";

const ARK_3D_BASE = "https://ark.cn-beijing.volces.com/api/v3";

export interface Ark3dSubmitOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
}

export interface Ark3dSubmitInput {
  model: string;
  images: string[];
  command?: string;
  /** 数美 Hitem3D 的方舟接口只接受可公开访问的图片 URL。 */
  requirePublicImageUrl?: boolean;
}

/** 影眸与数美共享方舟异步 3D 任务提交协议，模型参数放在 text 命令中。 */
export async function submitArk3dTask(
  input: Ark3dSubmitInput,
  options: Ark3dSubmitOptions,
): Promise<string> {
  if (input.images.length === 0) {
    throw new ChatServiceError("缺少 3D 参考图", 400, "reference_image_missing");
  }
  if (input.requirePublicImageUrl && input.images.some((image) => !/^https:\/\//i.test(image))) {
    throw new ChatServiceError(
      "火山数美 Hi3D 需要公网图片 URL；请先用 Seedream 生成或编辑参考图",
      409,
      "hi3d_public_image_required",
    );
  }
  const response = await (options.fetchFn ?? fetch)(
    `${ARK_3D_BASE}/contents/generations/tasks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        content: [
          ...(input.command ? [{ type: "text", text: input.command }] : []),
          ...input.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ChatServiceError(
      `火山 3D 任务提交失败（${response.status}）：${JSON.stringify(body).slice(0, 300)}`,
      502,
      "ark3d_submit_failed",
    );
  }
  if (typeof body.id !== "string" || !body.id) {
    throw new ChatServiceError("火山 3D 任务响应缺少 id", 502, "ark3d_submit_failed");
  }
  return body.id;
}

export function hyper3dCommand(options: { faceCount?: number; taPose?: boolean }): string {
  return [
    "--mesh_mode Raw",
    "--material PBR",
    "--fileformat glb",
    ...(options.faceCount ? [`--quality_override ${options.faceCount}`] : []),
    ...(options.taPose ? ["--TAPose true"] : []),
  ].join(" ");
}

export function hi3dCommand(options: { faceCount?: number; resolution?: "1536" | "1536pro" }): string {
  return [
    "--ff 2",
    `--resolution ${options.resolution ?? "1536"}`,
    "--request_type 3",
    ...(options.faceCount ? [`--face ${options.faceCount}`] : []),
  ].join(" ");
}
