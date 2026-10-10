export interface DesktopConnection { transport: "local" | "cloud"; instanceName: string | null }
export interface ToolConnection extends DesktopConnection { enabled: boolean; projectSlug: string | null }

export function connectionProblem(desktop: DesktopConnection, tools: ToolConnection, projectSlug: string): string | null {
  if (!tools.enabled) return "Blender 建模工具尚未启用。";
  if (desktop.transport !== tools.transport || desktop.instanceName !== tools.instanceName) {
    return "桌面和建模工具没有连接同一个 Blender。请先完成会话配置。";
  }
  if (tools.transport === "cloud" && tools.projectSlug !== projectSlug) return "这个 Blender 会话已分配给另一个工程。";
  return null;
}
