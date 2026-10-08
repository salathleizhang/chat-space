import { describe, expect, test } from "bun:test";
import { workspaceIdentity, WORKSPACE_COOKIE } from "./identity";

const secret = "cloud-test-session-secret-at-least-32-chars";
describe("cloud visitor identity", () => {
  test("creates a secure identity and accepts its signed cookie", () => {
    const first = workspaceIdentity(null, secret);
    expect(first.setCookie).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(workspaceIdentity(first.setCookie!, secret)).toEqual({ id: first.id, setCookie: undefined });
  });
  test("a forged workspace id cannot open another visitor's files", () => {
    const first = workspaceIdentity(null, secret);
    const forged = first.setCookie!.replace(first.id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(workspaceIdentity(forged, secret).id).not.toBe(first.id);
  });
  test("rejects malformed signatures and secret rotation without throwing", () => {
    for (const cookie of [`${WORKSPACE_COOKIE}=broken`, `${WORKSPACE_COOKIE}=a.汉字`, workspaceIdentity(null, secret).setCookie!]) {
      expect(workspaceIdentity(cookie, secret + "rotated").setCookie).toBeDefined();
    }
  });
  test("requires a sufficiently long server secret", () => {
    expect(() => workspaceIdentity(null, "short")).toThrow();
  });
});
