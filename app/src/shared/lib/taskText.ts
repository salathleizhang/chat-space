/** Display labels for tasks created by older local services and saved projects. */
export function taskSubjectLabel(subject: string): string {
  return subject
    .replace(/^3D 生成（火山 ([^）]+)）：/, "3D generation (Volcano Engine $1): ")
    .replace(/^3D 生成（Seed3D 直连）：/, "3D generation (Seed3D): ")
    .replace(/^3D 生成（Tripo 直连）：/, "3D generation (Tripo): ")
    .replace(/^3D 生成（混元直连）：/, "3D generation (Hunyuan): ")
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
    .replace(/^3D 人物生成：/, "3D character generation: ")
    .replace(/^UV 展开：/, "UV unwrapping: ")
    .replace(/^续跑：/, "Resume: ");
}
