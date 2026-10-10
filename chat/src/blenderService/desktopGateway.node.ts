// Real Node/TLS/upgrade fixture, bundled and launched by desktopGateway.test.ts.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { createDesktopGateway } from "./desktopGateway";
import { verifyIdentity } from "./auth";

const session = "b6ea4545-6029-44f5-a353-6fc4f60d4847", secret = "test-only-".repeat(5), desktop = "test-only-desktop-".repeat(3);
let live = true, requests = 0, activityRequests = 0, readOnly = false;
const upstream = https.createServer({ key: readFileSync(process.argv[2]!), cert: readFileSync(process.argv[3]!) }, (req, res) => {
  requests++;
  assert.equal(req.headers.authorization, "Basic " + Buffer.from(`${readOnly ? "kasm_viewer" : "kasm_user"}:${desktop}`).toString("base64"));
  assert.equal(req.headers["x-faas-instance-name"], "sandbox-fixture");
  assert.equal(req.headers["x-faas-proxy-port"], undefined);
  assert.equal(req.headers.cookie, undefined);
  res.setHeader("Set-Cookie", "upstream-secret=never-expose");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", "28"); res.setHeader("ETag", "old-html");
  res.end("<body>desktop-fixture</body>");
});
upstream.on("upgrade", (req, socket) => {
  assert.equal(req.headers["x-faas-proxy-port"], undefined);
  assert.equal(req.headers["x-faas-instance-name"], "sandbox-fixture");
  assert.equal(req.headers.authorization, "Basic " + Buffer.from(`kasm_user:${desktop}`).toString("base64"));
  const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("data", bytes => socket.write(bytes));
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
const target = `https://localhost:${(upstream.address() as AddressInfo).port}/`;
const gateway = createDesktopGateway({ secret, api: "http://127.0.0.1:3907", origin: "https://desktop.example.test", frames: ["https://www.example.test"] }, async (_url, init) => {
  const input = JSON.parse(String(init?.body));
  const claims = input.ticket === "bootstrap" ? { owner: "alice", session, epoch: 1 } : input.ticket ? verifyIdentity(input.ticket, secret, "desktop") : input;
  if (!live || claims.session !== session || claims.epoch !== 1) return new Response("", { status: 403 });
  if (input.activity) { if (readOnly) return new Response("", { status: 409 }); activityRequests++; }
  return Response.json({ owner: "alice", session, epoch: 1, target, instance: "sandbox-fixture", desktop, deadline: Date.now() + 60_000, readOnly });
});
await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
const port = (gateway.address() as AddressInfo).port, base = `http://127.0.0.1:${port}/desktop/${session}`;
try {
  const boot = await fetch(base + "/?ticket=bootstrap&resize=scale", { redirect: "manual" });
  assert.equal(boot.status, 303); assert.equal(boot.headers.get("location"), `/desktop/${session}/?resize=scale`);
  const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
  const response = await fetch(base + "/index.html", { headers: { Cookie: cookie, "x-faas-proxy-port": "9877" } });
  assert.equal(response.status, 200); assert.match(await response.text(), /desktop-fixture.*__lease\/activity.js/); assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("etag"), null);
  assert.equal((await fetch(base + "/__lease/renew", { headers: { Cookie: cookie } })).status, 204);
  assert.equal(activityRequests, 0);
  const script = await fetch(base + "/__lease/activity.js", { headers: { Cookie: cookie } });
  assert.equal(script.status, 200); assert.match(await script.text(), /event.isTrusted/);
  assert.equal((await fetch(base + "/__lease/activity", { method: "POST", headers: { Cookie: cookie, Origin: "https://attacker.test" } })).status, 401);
  assert.equal(activityRequests, 0);
  assert.equal((await fetch(base + "/__lease/activity", { method: "POST", headers: { Cookie: cookie, Origin: "https://desktop.example.test" } })).status, 204);
  assert.equal(activityRequests, 1);
  readOnly = true;
  const viewer = await fetch(base + "/index.html", { headers: { Cookie: cookie } });
  assert.equal(await viewer.text(), "<body>desktop-fixture</body>");
  assert.equal((await fetch(base + "/__lease/activity", { method: "POST", headers: { Cookie: cookie, Origin: "https://desktop.example.test" } })).status, 401);
  assert.equal(activityRequests, 1); readOnly = false;
  assert.equal((await fetch(base + "//attacker.example/", { headers: { Cookie: cookie } })).status, 401);
  assert.equal(requests, 2);
  const socket = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: `/desktop/${session}/websockify`, headers: {
      Origin: "https://desktop.example.test", Cookie: cookie, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": Buffer.alloc(16, 1).toString("base64"),
      "Sec-WebSocket-Version": "13", "x-faas-proxy-port": "9877" } });
    request.on("upgrade", (_response, socket) => resolve(socket)); request.on("error", reject); request.end();
  });
  const payload = Buffer.from([0x82, 0x02, 0x00, 0xff]);
  const echoed = new Promise<Buffer>(resolve => socket.once("data", resolve)); socket.write(payload);
  assert.deepEqual(await echoed, payload);
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  live = false;
  assert.equal((await fetch(`http://127.0.0.1:${port}/internal/tick`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } })).status, 204);
  socket.resume(); await closed;
  assert.equal((await fetch(base + "/index.html", { headers: { Cookie: cookie } })).status, 401);
  console.log("node-tls-binary-websocket-and-lease-revocation-passed");
} finally { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); }
