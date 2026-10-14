import { issueIdentity } from "../blenderService/auth";
import { cloudBudget } from "../models/blenderCloud";
import { boundedBody } from "../blenderService/objects";

export function serviceConfigured(env = process.env): boolean { return Boolean(env.BLENDER_SERVICE_URL && env.BLENDER_SERVICE_SECRET?.length && env.BLENDER_SERVICE_SECRET.length >= 32); }
/** A short, authenticated forwarding request. Desktop WebSocket goes to the dedicated gateway. */
export async function forwardBlender(request: Request, owner: string, env = process.env, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (!serviceConfigured(env)) return Response.json({ enabled: false, error: "Blender cloud service is not deployed yet" }, { status: 503 });
  const target = new URL(env.BLENDER_SERVICE_URL!);
  if (target.protocol !== "https:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Invalid Blender service URL");
  const address = new URL(request.url), path = address.pathname.replace(/^\/api\/blender/, "/v1");
  const allowed = request.method === "GET" && (/^\/v1\/sessions(?:\/[a-f0-9-]{36}(?:\/exports)?)?$/.test(path) || /^\/v1\/(operations|batches|exports)\/[a-f0-9-]{36}$/.test(path)) ||
    request.method === "POST" && (/^\/v1\/(sessions|batches)$/.test(path) || /^\/v1\/sessions\/[a-f0-9-]{36}\/(operations|end|desktop|resume|answer|retry)$/.test(path) || /^\/v1\/batches\/[a-f0-9-]{36}\/cancel$/.test(path));
  // Vercel adds the unused :path* rewrite capture to the request query. It may
  // describe the already validated URL path, but must never choose a route.
  const query = [...address.searchParams];
  const rewriteCapture = env.VERCEL === "1" && query.length === 1 && query[0]![0] === "path" &&
    query[0]![1] === address.pathname.slice("/api/".length);
  if (!allowed || address.search && !rewriteCapture) return Response.json({ error: "Blender request not allowed" }, { status: 403 });
  const body = request.method === "POST" ? await boundedBody(new Response(request.body), 256 * 1024) : undefined;
  return cloudBudget(async signal => {
    const upstream = await fetchFn(new URL(path, target), { method: request.method, redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + issueIdentity({ owner, scope: "api", expires: Date.now() + 60_000 }, env.BLENDER_SERVICE_SECRET!) },
      ...(body ? { body: Buffer.from(body) } : {}) });
    // Strip upstream cookies/headers; the website keeps using its own signed workspace identity.
    const bytes = await boundedBody(new Response(upstream.body, { status: 200 }), 16 * 1024 * 1024);
    return new Response(Buffer.from(bytes), { status: upstream.status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  }, 20_000);
}
