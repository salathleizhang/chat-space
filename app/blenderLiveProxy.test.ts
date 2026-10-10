import { afterEach, describe, expect, test } from "bun:test";
import { fetch as nativeFetch } from "bun";
import { blenderLiveProxy } from "./blenderLiveProxy";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function frontend(target: string) {
  // Vite runs on Node. Bun's node:http upgrade implementation behaves differently;
  // exercise the proxy on the actual runtime, while Bun remains the test runner.
  const source = `
    import http from 'node:http';
    import { blenderLiveProxy } from ${JSON.stringify(import.meta.resolve("./blenderLiveProxy.ts"))};
    let middleware;
    const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
    blenderLiveProxy({ target: ${JSON.stringify(target)}, user: 'kasm_user', pass: 'test-password', instanceName: 'sandbox-a' })
      .configureServer({ httpServer: server, middlewares: { use(fn) { middleware = fn; } } });
    server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
  `;
  const process = Bun.spawn(["node", "--input-type=module", "-e", source], { stdout: "pipe", stderr: "inherit" });
  closers.push(async () => { process.kill(); await process.exited; });
  const reader = process.stdout.getReader();
  const result = await reader.read();
  reader.releaseLock();
  if (!result.value) throw new Error("Node proxy server failed to start");
  return new TextDecoder().decode(result.value).trim();
}

describe("Blender desktop cloud proxy", () => {
  test("routes HTTP to the instance with server-side credentials and respects mount boundaries", async () => {
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      const body = JSON.stringify({ path: new URL(request.url).pathname, query: new URL(request.url).search,
                             auth: request.headers.get("authorization"), instance: request.headers.get("x-faas-instance-name") });
      // happy-dom replaces global fetch/Response in the app suite. Use Bun's real
      // response so the HTTP fixture and client do not acquire browser CORS rules.
      return nativeFetch(`data:application/json,${encodeURIComponent(body)}`);
    } });
    closers.push(async () => { await upstream.stop(true); });
    const url = await frontend(upstream.url.toString());
    const response = await nativeFetch(`${url}/blender-live/vnc.html?resize=scale`);
    expect(await response.json()).toEqual({ path: "/vnc.html", query: "?resize=scale", instance: "sandbox-a",
      auth: `Basic ${Buffer.from("kasm_user:test-password").toString("base64")}` });
    expect((await nativeFetch(`${url}/blender-live-other`)).status).toBe(404);
    expect(await (await nativeFetch(`${url}/blender-live/connection`)).json()).toEqual({ transport: "cloud", instanceName: "sandbox-a" });
  });

  test("routes the root WebSocket to the same instance and transfers binary frames", async () => {
    const handshake: { instance: string | null; authorization: string | null } = { instance: null, authorization: null };
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request, server) {
      handshake.instance = request.headers.get("x-faas-instance-name");
      handshake.authorization = request.headers.get("authorization");
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "binary" } })) return;
      return new Response("no upgrade", { status: 400 });
    }, websocket: { message(ws, message) { ws.send(message); } } });
    closers.push(async () => { await upstream.stop(true); });
    const url = await frontend(upstream.url.toString());
    const ws = new WebSocket(url.replace("http:", "ws:") + "/websockify", "binary");
    closers.push(async () => { ws.close(); });
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    ws.binaryType = "arraybuffer";
    const received = new Promise<ArrayBuffer>((resolve) => { ws.onmessage = (event) => resolve(event.data); });
    ws.send(new Uint8Array([0, 255, 12, 14]));
    expect(new Uint8Array(await received)).toEqual(new Uint8Array([0, 255, 12, 14]));
    expect(handshake.instance).toBe("sandbox-a");
    expect(handshake.authorization).toBe(`Basic ${Buffer.from("kasm_user:test-password").toString("base64")}`);
    ws.close();
  });

  test("refuses unencrypted public targets and URL credentials", () => {
    for (const target of ["http://desktop.example", "https://user:secret@desktop.example"]) {
      expect(() => blenderLiveProxy({ target, user: "kasm_user", pass: "test" })).toThrow();
    }
  });
});
