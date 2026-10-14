export interface DesktopConnection { transport: "local" | "cloud"; instanceName: string | null }
export interface ToolConnection extends DesktopConnection { enabled: boolean; projectSlug: string | null }

export function connectionProblem(desktop: DesktopConnection, tools: ToolConnection, projectSlug: string): string | null {
  if (!tools.enabled) return "The Blender modeling tool is not enabled yet.";
  if (desktop.transport !== tools.transport || desktop.instanceName !== tools.instanceName) {
    return "The desktop and the modeling tool are not connected to the same Blender. Finish the session configuration first.";
  }
  if (tools.transport === "cloud" && tools.projectSlug !== projectSlug) return "This Blender session is assigned to another project.";
  return null;
}
