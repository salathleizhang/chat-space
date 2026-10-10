import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("desktop gateway relays real Node TLS/binary upgrades, fences revoked leases and never forwards control headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatspace-gateway-test-"));
  try {
    const key = join(directory, "key.pem"), cert = join(directory, "cert.pem"), bundle = join(directory, "fixture.mjs");
    await writeFile(join(directory, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\n");
    const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-config", join(directory, "openssl.cnf")], { stdout: "pipe", stderr: "pipe" });
    expect(await openssl.exited).toBe(0);
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "desktopGateway.node.ts")], target: "node", format: "esm" });
    expect(built.success).toBe(true); await writeFile(bundle, await built.outputs[0]!.text());
    const child = Bun.spawn(["node", bundle, key, cert], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(0); expect(stdout).toContain("node-tls-binary-websocket-and-lease-revocation-passed");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20_000);
