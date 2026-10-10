import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { issueIdentity } from "./auth";
import { onTaskPumpTick, tickTaskPumps } from "../common/taskPump";
import { DESKTOP_ACTIVITY_SCRIPT, withDesktopActivity } from "./desktopActivity";

type Grant = { owner: string; session: string; epoch: number; target: string; instance: string; desktop: string; deadline: number; readOnly?: boolean };
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization"]);
/** Node runtime: the existing desktop proxy was validated with Node's upgrade sockets. */
export function createDesktopGateway(settings: { secret: string; api: string; origin: string; frames: string[] }, fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch) {
  const connections = new Map<Duplex, Grant>();
  const leases = new Map<string, number>();
  const pendingSockets = new Set<Duplex>();
  const api = new URL(settings.api), origin = new URL(settings.origin);
  if (!['127.0.0.1', 'localhost'].includes(api.hostname) || api.protocol !== "http:" || origin.protocol !== "https:") throw new Error("Invalid desktop gateway settings");
  async function authorize(input: ({ ticket: string } | Pick<Grant, "owner" | "session" | "epoch">) & { activity?: boolean }): Promise<Grant> {
    const token = issueIdentity({ owner: "__gateway", scope: "api", expires: Date.now() + 30_000 }, settings.secret);
    const controller = new AbortController(), deadline = Date.now() + 10_000;
    const unsubscribe = onTaskPumpTick(() => { if (Date.now() >= deadline) controller.abort(); });
    let grant: Grant;
    try {
      const response = await fetchFn(new URL("/internal/desktop", api), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(input), redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("Desktop lease unavailable");
      grant = await response.json() as Grant;
    } finally { unsubscribe(); controller.abort(); }
    const target = new URL(grant.target);
    if (target.protocol !== "https:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash || !/^[A-Za-z0-9_-]{1,200}$/.test(grant.instance) || !/^[A-Za-z0-9_-]{32,128}$/.test(grant.desktop)) throw new Error("Invalid desktop grant");
    return grant;
  }
  function scopedRequest(req: http.IncomingMessage) {
    const address = new URL(req.url ?? "/", origin), match = address.pathname.match(/^\/desktop\/([a-f0-9-]{36})(\/.*)$/);
    if (!match) throw new Error("Invalid desktop route");
    const id = match[1]!, cookieName = `__Host-cs-blender-${id}`;
    const ticket = address.searchParams.get("ticket") ?? req.headers.cookie?.split(";").map(p => p.trim()).find(p => p.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    if (!ticket) throw new Error("Desktop ticket missing");
    address.searchParams.delete("ticket"); address.searchParams.delete("faasInstanceName");
    return { id, cookieName, ticket, path: match[2]! + address.search, bootstrapping: new URL(req.url ?? "/", origin).searchParams.has("ticket") };
  }
  function upstreamURL(path: string, target: string): URL {
    const base = new URL(target), result = new URL(path, base);
    // A route suffix such as //another-host must never receive desktop credentials.
    if (result.origin !== base.origin || result.username || result.password) throw new Error("Invalid upstream path");
    return result;
  }
  const server = http.createServer(async (req, res) => {
    if (req.url === "/internal/tick" && req.method === "POST") {
      const expected = Buffer.from(`Bearer ${settings.secret}`), provided = Buffer.from(req.headers.authorization ?? "");
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) { res.writeHead(401).end(); return; }
      tickTaskPumps();
      for (const [socket, grant] of connections) {
        try { await authorize(grant); } catch { connections.delete(socket); socket.destroy(); }
      }
      res.writeHead(204).end(); return;
    }
    try {
      const scope = scopedRequest(req), pathname = scope.path.split("?")[0];
      const activity = pathname === "/__lease/activity" && req.method === "POST";
      if (activity ? req.headers.origin !== origin.origin || scope.bootstrapping : !['GET', 'HEAD'].includes(req.method ?? "")) throw new Error("Invalid desktop method or origin");
      const grant = await authorize({ ticket: scope.ticket, ...(activity ? { activity: true } : {}) });
      if (grant.session !== scope.id) throw new Error("Wrong desktop session");
      if (activity) {
        if (grant.readOnly) throw new Error("Read-only desktop");
        res.writeHead(204, { "Cache-Control": "no-store" }).end(); return;
      }
      if (scope.bootstrapping) {
        const cookieTicket = issueIdentity({ owner: grant.owner, session: grant.session, epoch: grant.epoch, scope: "desktop", expires: Date.now() + 5 * 60_000 }, settings.secret);
        const redirect = new URL(req.url!, origin); redirect.searchParams.delete("ticket");
        res.writeHead(303, { Location: redirect.pathname + redirect.search,
          "Set-Cookie": `${scope.cookieName}=${cookieTicket}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).end(); return;
      }
      if (scope.path.split("?")[0] === "/__lease/renew") { res.writeHead(204, { "Cache-Control": "no-store" }).end(); return; }
      if (pathname === "/__lease/activity.js") {
        if (grant.readOnly) throw new Error("Read-only desktop");
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).end(req.method === "HEAD" ? undefined : DESKTOP_ACTIVITY_SCRIPT); return;
      }
      const target = upstreamURL(scope.path, grant.target);
      const upstream = https.request(target, { method: req.method, headers: { Authorization: "Basic " + Buffer.from(`${grant.readOnly ? "kasm_viewer" : "kasm_user"}:${grant.desktop}`).toString("base64"),
        "x-faas-instance-name": grant.instance, "Accept-Encoding": "identity" }, rejectUnauthorized: true }, response => {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(response.headers)) if (!HOP.has(key) && !["set-cookie", "www-authenticate", "location"].includes(key)) headers[key] = value;
        headers['Cache-Control'] = 'private, no-store'; headers['Referrer-Policy'] = 'no-referrer'; headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
        headers['Content-Security-Policy'] = `frame-ancestors ${settings.frames.join(" ")}`;
        if (!grant.readOnly && req.method === "GET" && response.statusCode === 200 && String(headers['content-type']).includes("text/html")) {
          // Inject the input reporter only in manual HTML, never into the WebSocket stream.
          const chunks: Buffer[] = []; let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) { response.destroy(); if (!res.headersSent) res.writeHead(502); res.end(); }
            else chunks.push(chunk);
          });
          response.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
          response.on("end", () => {
            if (res.writableEnded) return;
            if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') { res.writeHead(502).end(); return; }
            for (const key of ['content-length', 'etag', 'last-modified']) delete headers[key];
            res.writeHead(200, headers).end(withDesktopActivity(Buffer.concat(chunks).toString("utf8"), grant.session));
          });
        } else { res.writeHead(response.statusCode ?? 502, headers); response.pipe(res); }
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on("close", () => upstream.destroy());
      req.on("close", () => { if (!req.complete) upstream.destroy(); }); upstream.end();
    } catch { res.writeHead(401, { "Cache-Control": "no-store" }).end("Desktop session unavailable"); }
  });
  server.on("upgrade", async (req, socket, head) => {
    pendingSockets.add(socket);
    socket.on("error", () => socket.destroy());
    let lease: string | undefined, released = false;
    const release = () => { if (!lease || released) return; released = true; const count = (leases.get(lease) ?? 1) - 1; if (count) leases.set(lease, count); else leases.delete(lease); };
    socket.once("close", () => { pendingSockets.delete(socket); release(); });
    try {
      if (req.headers.origin !== origin.origin) throw new Error("Invalid desktop origin");
      const scope = scopedRequest(req);
      if (!scope.path.startsWith("/websockify") || scope.path.split("?")[0] !== "/websockify") throw new Error("Invalid desktop socket path");
      const grant = await authorize({ ticket: scope.ticket });
      if (socket.destroyed) throw new Error("Desktop client disconnected");
      if (grant.session !== scope.id) throw new Error("Wrong desktop session");
      const key = `${grant.session}:${grant.epoch}`, count = leases.get(key) ?? 0;
      if (count >= (grant.readOnly ? 2 : 1)) throw new Error("Desktop connection quota reached");
      lease = key; leases.set(key, count + 1);
      const target = upstreamURL(scope.path, grant.target), headers: http.OutgoingHttpHeaders = { Host: target.host, Origin: target.origin,
        Authorization: "Basic " + Buffer.from(`${grant.readOnly ? "kasm_viewer" : "kasm_user"}:${grant.desktop}`).toString("base64"), "x-faas-instance-name": grant.instance };
      for (const key of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
        const value = req.headers[key]; if (value) headers[key] = value;
      }
      const upstream = https.request(target, { headers, rejectUnauthorized: true });
      socket.once("close", () => upstream.destroy());
      upstream.on("upgrade", (response, remote, upstreamHead) => {
        if (response.statusCode !== 101 || socket.destroyed) { remote.destroy(); socket.destroy(); return; }
        pendingSockets.delete(socket);
        connections.set(socket, grant); socket.on("close", () => { connections.delete(socket); remote.destroy(); });
        remote.on("close", () => socket.destroy());
        remote.on("error", () => socket.destroy()); socket.on("error", () => remote.destroy());
        const allowedHeaders = Object.entries(response.headers).filter(([key]) => !["set-cookie", "authorization"].includes(key));
        socket.write("HTTP/1.1 101 Switching Protocols\r\n" + allowedHeaders.map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n\r\n");
        if (upstreamHead.length) socket.write(upstreamHead); if (head.length) remote.write(head);
        socket.pipe(remote); remote.pipe(socket);
      });
      upstream.on("response", response => { response.resume(); socket.destroy(); });
      upstream.on("error", () => socket.destroy()); upstream.end();
    } catch { socket.destroy(); }
  });
  return Object.assign(server, { shutdownSockets: () => { for (const socket of pendingSockets) socket.destroy(); for (const socket of connections.keys()) socket.destroy(); pendingSockets.clear(); connections.clear(); } });
}
