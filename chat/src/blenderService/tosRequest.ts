import { TosClient } from "@volcengine/tos-sdk";

/** The SDK presigned-URL API cannot sign extra headers. Let its public PutObject
 * path sign the immutable PUT, capturing the request without sending a body.
 * Native fetch then streams the real bytes with an external task-pump deadline.
 * Each signing client has a private adapter; concurrent requests never share it. */
export async function immutableTosPut(client: TosClient, bucket: string, key: string, bytes: number, md5: string, type: string) {
  if (!key.startsWith("blender/") || key.split("/").some(p => !p || p === "..") || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Invalid TOS object");
  let request: { url: string; headers: Record<string, string> } | undefined;
  const signer = new TosClient({ ...client.opts, maxRetryCount: 0, enableCRC: false });
  // 2.9.1 normalizes away the constructor's requestAdapter option.
  signer.opts.requestAdapter = async config => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers ?? {})) if (typeof value === "string" && !["host", "user-agent"].includes(name.toLowerCase())) headers[name] = value;
    request = { url: new URL(config.url!, config.baseURL).href, headers };
    return { status: 200, statusText: "OK", headers: {}, data: "", config };
  };
  await signer.putObject({ bucket, key, contentLength: bytes, contentMD5: md5, contentType: type, forbidOverwrite: true });
  if (!request || !request.headers.authorization?.includes("x-tos-forbid-overwrite")) throw new Error("TOS immutable PUT was not signed");
  return request;
}
