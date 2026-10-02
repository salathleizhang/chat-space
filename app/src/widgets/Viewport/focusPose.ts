/**
 * **聚焦某物时的机位**：位置 + 注视点，以及那个固定偏移。
 *
 * 这一个算式同时服务两条入口，必须是同一份实现：
 *  - 双击模型列表（`index.tsx` 的 `cameraTarget` → `CameraRig` 缓动过去）；
 *  - agent 的贴近检查（`index.tsx` 算好机位交给 `CloseupInspectionRig` 飞过去、拍完飞回来）。
 *
 * 为什么强调"同一份"：用户按下贴近检查时，期望是"agent 凑近看到的就是我双击看到的那一帧"。
 * 两处各写一遍 `+ [3,2,3]`，早晚会有一处被单独调过（比如为了"更近一点"），
 * 于是同一台相机有两个"聚焦机位"，而差异只在某个模型上才看得出来。
 */

/** 聚焦时相机相对目标**摆放位置**的固定偏移（世界单位）。 */
export const FOCUS_CAMERA_OFFSET: readonly [number, number, number] = [3, 2, 3];

export interface FocusPose {
  camPos: [number, number, number];
  lookAt: [number, number, number];
}

/**
 * 由摆放位置算出聚焦机位：看向位置本身，相机偏在斜上方（Blender 式 3/4 视角）。
 *
 * 返回的是**新数组**：调用方（`cameraTargetRef`、飞行器）会长期持有它，
 * 与摆放表共用引用的话，一次就地写入就能把场景布局改脏。
 */
export function focusPoseFor(position: readonly [number, number, number]): FocusPose {
  return {
    camPos: [
      position[0] + FOCUS_CAMERA_OFFSET[0],
      position[1] + FOCUS_CAMERA_OFFSET[1],
      position[2] + FOCUS_CAMERA_OFFSET[2],
    ],
    lookAt: [position[0], position[1], position[2]],
  };
}
