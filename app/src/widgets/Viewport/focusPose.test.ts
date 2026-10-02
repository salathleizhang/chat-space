import { describe, expect, test } from "bun:test";
import { FOCUS_CAMERA_OFFSET, focusPoseFor } from "./focusPose";

/**
 * 这两条是"双击看到的"和"agent 贴近检查看到的"是同一帧的依据：
 * 偏移只有一处定义，而且它必须真的是文档里那个 [3,2,3]。
 */
describe("聚焦机位", () => {
  test("固定偏移就是 [3,2,3]（双击与贴近检查共用的那个口径）", () => {
    expect([...FOCUS_CAMERA_OFFSET]).toEqual([3, 2, 3]);
  });

  test("机位 = 摆放位置 + 偏移，注视点就是摆放位置本身", () => {
    const pose = focusPoseFor([1, 2, 3]);
    expect(pose.camPos).toEqual([4, 4, 6]);
    expect(pose.lookAt).toEqual([1, 2, 3]);
  });

  test("返回的是新数组：与摆放表共用引用的话，一次就地写入就把布局改脏了", () => {
    const position: [number, number, number] = [0.5, 0, -0.25];
    const pose = focusPoseFor(position);
    expect(pose.lookAt).not.toBe(position);
    pose.lookAt[0] = 999;
    pose.camPos[1] = 999;
    expect(position).toEqual([0.5, 0, -0.25]);
  });
});
