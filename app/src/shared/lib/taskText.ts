/** Display labels for tasks created by older local services and saved projects. */
export function taskSubjectLabel(subject: string): string {
  return subject
    .replace(/^3D 生成（火山 ([^）]+)）：/, "3D generation (Volcano Engine $1): ")
    .replace(/^3D 生成（Seed3D 直连）：/, "3D generation (Seed3D): ")
    .replace(/^3D 生成（Tripo 直连）：/, "3D generation (Tripo): ")
    .replace(/^3D 生成：/, "3D generation: ")
    .replace(/^世界生成（World Labs）$/, "World generation (World Labs)")
    .replace(/^空环境生成（World Labs）$/, "Empty environment generation (World Labs)")
    .replace(/^完整场景生成$/, "Complete scene generation")
    .replace(/^天空盒生成（Blockade Labs）$/, "Skybox generation (Blockade Labs)")
    .replace(/^部件分割：/, "Part segmentation: ")
    .replace(/^贴图生成：/, "Texture generation: ")
    .replace(/^重拓扑：/, "Retopology: ")
    .replace(/^绑骨蒙皮：/, "Rigging and skinning: ")
    .replace(/^动作生成：/, "Animation generation: ")
    .replace(/^3D 人物生成（Tripo）：/, "3D character generation (Tripo): ")
    .replace(/^3D 人物生成：/, "3D character generation: ")
    .replace(/^UV 展开：/, "UV unwrapping: ")
    .replace(/^续跑：/, "Resume: ");
}

/**
 * `running` 但长时间没有进展 → 一行诊断文案。
 *
 * 时长分两档（秒 / 分钟），避免 1 Hz 的看板把一串数字刷在列表里；
 * `pumpActive=false` 是另一层意思：本机已经没有推进闸门照看它（见 chat 侧 `common/taskPump.ts`），
 * 那才需要续跑或重试，而"慢了"只需要继续等。
 */
export function taskStallLabel(stall: { silentForMs: number; pumpActive: boolean }): string {
  const seconds = Math.max(1, Math.round(stall.silentForMs / 1000));
  // 两分钟以内按秒（90 秒的告警阈值刚过时要看到"90s"，而不是四舍五入成"2 min"）
  const waited = seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
  return stall.pumpActive ? `no progress for ${waited}` : `no local driver for ${waited}`;
}
