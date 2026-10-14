import { describe, expect, test } from "bun:test";
import { connectionProblem } from "./connection";

describe("Blender desktop/tool session alignment", () => {
  test("cloud desktop cannot silently drive a local Blender", () => {
    expect(connectionProblem({ transport: "cloud", instanceName: "sandbox-a" },
      { transport: "local", instanceName: null, enabled: true, projectSlug: null }, "p-a")).toContain("same Blender");
  });
  test("different sandbox or project cannot share an active Blender", () => {
    const desktop = { transport: "cloud" as const, instanceName: "sandbox-a" };
    const tool = { ...desktop, enabled: true, projectSlug: "p-a" };
    expect(connectionProblem(desktop, { ...tool, instanceName: "sandbox-b" }, "p-a")).toContain("same Blender");
    expect(connectionProblem(desktop, tool, "p-b")).toContain("another project");
    expect(connectionProblem(desktop, tool, "p-a")).toBeNull();
  });
  test("local mode and disabled tools remain explicit", () => {
    const desktop = { transport: "local" as const, instanceName: null };
    expect(connectionProblem(desktop, { ...desktop, enabled: true, projectSlug: null }, "p-a")).toBeNull();
    expect(connectionProblem(desktop, { ...desktop, enabled: false, projectSlug: null }, "p-a")).toContain("not enabled yet");
  });
});
