import { describe, expect, test } from "bun:test";
import {
  HAND_ANCHORS,
  HAND_CONNECTIONS,
  HAND_LANDMARK_COUNT,
  INDEX_TIP,
  MIDDLE_MCP,
  PALM_RIM,
  PINCH_END_RATIO,
  PINCH_START_RATIO,
  THUMB_TIP,
  WRIST,
  handScale,
  orthographicExtents,
  perspectiveExtents,
  physicalHandFor,
  pinchRatio,
  projectHand,
  smoothLandmarks,
  updatePinch,
  type HandLandmarks,
} from "./handLandmarks";
import { syntheticHandLandmarks } from "./handDebug";

/**
 * 手势模式的**纯数值契约**。
 *
 * 这段代码的错法全部是静默的：镜像写反是"手跟着反方向动"、手性写反是"左右手互换"、
 * z 的符号写反是"手指朝脑袋里弯"、钳制写错是"手跑出画面"。所以每条判据都盯一个具体事实，
 * 而不是"函数没抛异常"。
 */

const CENTER: [number, number] = [0.5, 0.6];
const openHand = () => syntheticHandLandmarks({ center: CENTER });

const meanOf = (landmarks: HandLandmarks, indices: readonly number[]) => {
  let x = 0;
  let y = 0;
  for (const index of indices) {
    x += landmarks[index]!.x;
    y += landmarks[index]!.y;
  }
  return { x: x / indices.length, y: y / indices.length };
};

describe("MediaPipe 拓扑表", () => {
  test("21 个点、21 条连接，且下标都在范围内", () => {
    expect(HAND_LANDMARK_COUNT).toBe(21);
    expect(HAND_CONNECTIONS).toHaveLength(21);
    for (const [a, b] of HAND_CONNECTIONS) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(21);
      expect(a).not.toBe(b);
    }
  });

  test("掌心那 5 个点就是手腕 + 四个 MCP", () => {
    expect([...PALM_RIM]).toEqual([WRIST, 5, MIDDLE_MCP, 13, 17]);
  });
});

describe("手性换算", () => {
  test("默认**不对调**：实测 tasks-vision 对原始帧直接给物理手", () => {
    /*
      判据是一张自证图（手心朝镜头 + 拇指在画面右侧 ⇒ 右手），模型对它报 "Right"。
      见 `.tmp/hand-verify/ask-handedness.mjs`；这条写错就是"左手控制右手"。
    */
    expect(physicalHandFor("Right")).toBe("right");
    expect(physicalHandFor("Left")).toBe("left");
  });

  test("需要按文档口径对调时显式传 false（换 MediaPipe 版本后可能要翻）", () => {
    expect(physicalHandFor("Left", false)).toBe("right");
    expect(physicalHandFor("Right", false)).toBe("left");
  });
});

describe("掌长与捏合", () => {
  test("掌长 = 腕 → 中指 MCP 的距离", () => {
    const landmarks = openHand();
    const expected = Math.hypot(
      landmarks[WRIST]!.x - landmarks[MIDDLE_MCP]!.x,
      landmarks[WRIST]!.y - landmarks[MIDDLE_MCP]!.y,
      landmarks[WRIST]!.z - landmarks[MIDDLE_MCP]!.z,
    );
    expect(handScale(landmarks)).toBeCloseTo(expected, 12);
    expect(handScale(landmarks)).toBeGreaterThan(0.05);
  });

  test("合成的张开手算张开、捏合手算捏住（比值卡在两个阈值之间）", () => {
    const open = pinchRatio(syntheticHandLandmarks({ center: CENTER }));
    const pinched = pinchRatio(syntheticHandLandmarks({ center: CENTER, pinched: true }));
    expect(open).toBeGreaterThan(PINCH_END_RATIO);
    expect(pinched).toBeLessThan(PINCH_START_RATIO);
  });

  test("掌长退化为 0 时比值是 +∞（而不是 NaN 或 0）", () => {
    const degenerate = openHand().map(() => ({ x: 0.5, y: 0.5, z: 0 }));
    expect(pinchRatio(degenerate)).toBe(Number.POSITIVE_INFINITY);
    expect(updatePinch(false, pinchRatio(degenerate))).toBe(false);
  });

  test("捏合迟滞：中间地带保持原状态，两个阈值各管一边", () => {
    const middle = (PINCH_START_RATIO + PINCH_END_RATIO) / 2;
    // 没捏住 → 停在中间地带仍是没捏住（单阈值会在这里抖）
    expect(updatePinch(false, middle)).toBe(false);
    // 已经捏住 → 停在中间地带仍是捏住
    expect(updatePinch(true, middle)).toBe(true);
    expect(updatePinch(false, PINCH_START_RATIO)).toBe(true);
    expect(updatePinch(true, PINCH_END_RATIO)).toBe(true);
    expect(updatePinch(true, PINCH_END_RATIO + 0.01)).toBe(false);
  });

  test("捏住的判据看的是几何：把拇指尖挪到食指尖旁边就捏住了", () => {
    const landmarks = openHand().map((point) => ({ ...point }));
    const index = landmarks[INDEX_TIP]!;
    landmarks[THUMB_TIP] = { x: index.x - 0.005, y: index.y, z: index.z };
    expect(pinchRatio(landmarks)).toBeLessThan(PINCH_START_RATIO);
  });
});

describe("关键点平滑", () => {
  test("α=0.5 时结果落在两帧中间", () => {
    const before = openHand();
    const after = before.map((point) => ({ ...point, x: point.x + 0.1 }));
    const smoothed = smoothLandmarks(before, after, 0.5);
    expect(smoothed[WRIST]!.x).toBeCloseTo(before[WRIST]!.x + 0.05, 10);
  });

  test("没有历史或点数不匹配时原样采用这一帧（且是副本，不共享引用）", () => {
    const frame = openHand();
    const first = smoothLandmarks(null, frame);
    expect(first).toHaveLength(HAND_LANDMARK_COUNT);
    expect(first[0]).not.toBe(frame[0]);

    const half = frame.slice(0, 5);
    expect(smoothLandmarks(frame, half)).toHaveLength(5);
  });
});

describe("画面 → 相机空间", () => {
  test("透视可见范围 = 2·d·tan(fov/2)，宽度再乘 aspect", () => {
    const extents = perspectiveExtents(90, 2, 1);
    expect(extents.height).toBeCloseTo(2, 10);
    expect(extents.width).toBeCloseTo(4, 10);
  });

  test("正交可见范围与距离无关", () => {
    expect(orthographicExtents(7.5, -7.5, 1.5)).toEqual({ height: 15, width: 22.5 });
  });

  test("锚点落在掌心时偏移为 0，骨架以手掌中心为原点", () => {
    /*
      锚点是"掌心在画面里的静止位置"，而掌心 = 5 个掌点的均值（不是构造合成手时给的那个
      `center`：模板原点在腕与中指 MCP 之间，掌心还偏拇指侧一点）。所以这里拿真实的掌心
      当锚点，偏移才应当恰好是 0。
    */
    const landmarks = openHand();
    const centroid = meanOf(landmarks, PALM_RIM);
    const projection = projectHand(landmarks, {
      mirror: false,
      extents: { width: 4, height: 2 },
      anchor: [centroid.x, centroid.y],
    });
    expect(projection.palmOffset[0]).toBeCloseTo(0, 10);
    expect(projection.palmOffset[1]).toBeCloseTo(0, 10);
    expect(projection.palmOffset[2]).toBe(0);
    // 掌心 5 个点在**相对坐标系**里的均值就是原点（构造如此）
    const sumX = PALM_RIM.reduce((total, index) => total + projection.joints[index]![0], 0);
    const sumY = PALM_RIM.reduce((total, index) => total + projection.joints[index]![1], 0);
    expect(sumX / PALM_RIM.length).toBeCloseTo(0, 10);
    expect(sumY / PALM_RIM.length).toBeCloseTo(0, 10);
  });

  test("镜像：x → 1−x（手往右挪，屏幕上的手也往右挪）", () => {
    const landmarks = syntheticHandLandmarks({ center: [0.25, 0.6] });
    const mirrored = projectHand(landmarks, {
      mirror: true,
      extents: { width: 2, height: 2 },
      anchor: [0.5, 0.5],
    });
    const raw = projectHand(landmarks, {
      mirror: false,
      extents: { width: 2, height: 2 },
      anchor: [0.5, 0.5],
    });
    expect(mirrored.palmScreen.x).toBeCloseTo(1 - raw.palmScreen.x, 10);
    // 镜像后偏移是正方向（往右），未镜像时是负方向
    expect(mirrored.palmOffset[0]).toBeGreaterThan(0);
    expect(raw.palmOffset[0]).toBeLessThan(0);
  });

  test("钳到画面内：手伸出去还在画面里，但**不是**绕着锚点的一小圈", () => {
    /*
      这条是**回归钉子**：第一版把钳制写成"锚点 ± 0.22"，右手（锚点 0.67）于是只能到
      x ∈ [0.45, 0.89]——屏幕上半部与左半边都够不到，模型在画面中上部时射线永远指不上。
      现在的口径是"钳到画面内"，所以掌心可以走到几乎任何一个屏幕位置。
    */
    const options = { mirror: false, extents: { width: 2, height: 2 }, anchor: [0.67, 0.66] as [number, number] };
    // 指尖伸到画面外一点：钳到 0.96，仍然在画面里
    const outside = projectHand(syntheticHandLandmarks({ center: [1.08, 0.6] }), options);
    expect(outside.palmScreen.x).toBeGreaterThan(1);
    expect(outside.palmOffset[0]).toBeCloseTo((0.96 - 0.67) * 2, 6);
    // 画面上半部与左半边必须够得到（旧口径在这里会贴死在 0.44 / 0.45 上）
    const upperLeft = projectHand(syntheticHandLandmarks({ center: [0.25, 0.2] }), options);
    expect(upperLeft.palmOffset[0]).toBeLessThan(-0.5);
    expect(upperLeft.palmOffset[1]).toBeGreaterThan(0.5);
  });

  test("整只手在画面里平移只改 palmOffset，不改骨架的相对几何", () => {
    const base = syntheticHandLandmarks({ center: [0.5, 0.5] });
    const shifted = syntheticHandLandmarks({ center: [0.7, 0.4] });
    const options = { mirror: false, extents: { width: 2, height: 2 }, anchor: [0.5, 0.5] as [number, number] };
    const a = projectHand(base, options);
    const b = projectHand(shifted, options);
    expect(a.palmOffset[0]).not.toBeCloseTo(b.palmOffset[0], 6);
    for (let index = 0; index < HAND_LANDMARK_COUNT; index += 1) {
      expect(b.joints[index]![0]).toBeCloseTo(a.joints[index]![0], 10);
      expect(b.joints[index]![1]).toBeCloseTo(a.joints[index]![1], 10);
    }
  });

  test("手的平面内旋转会体现在关节坐标上（不是只把整只手挪个位置）", () => {
    const landmarks = openHand();
    // 绕**真实掌心中心**（5 个掌点的均值，不等于构造时给的 center）转 90°，图像坐标里 y 向下
    const pivot = meanOf(landmarks, PALM_RIM);
    const rotated = landmarks.map((point) => ({
      x: pivot.x - (point.y - pivot.y),
      y: pivot.y + (point.x - pivot.x),
      z: point.z,
    }));
    const options = { mirror: false, extents: { width: 2, height: 2 }, anchor: CENTER };
    const before = projectHand(landmarks, options);
    const after = projectHand(rotated, options);
    const wristBefore = before.joints[WRIST]!;
    const wristAfter = after.joints[WRIST]!;
    // 手腕相对掌心在旋转前后应当换了轴：原来在 +y（图像坐标里在掌心下方），转后到 −x
    expect(Math.abs(wristBefore[1])).toBeGreaterThan(Math.abs(wristBefore[0]));
    expect(Math.abs(wristAfter[0])).toBeGreaterThan(Math.abs(wristAfter[1]));
  });

  test("两只手的锚点一左一右（参考图里的构图）", () => {
    expect(HAND_ANCHORS.left[0]).toBeLessThan(0.5);
    expect(HAND_ANCHORS.right[0]).toBeGreaterThan(0.5);
    // y 是图像坐标（向下为正）：手在画面下半部
    expect(HAND_ANCHORS.left[1]).toBeGreaterThan(0.5);
    expect(HAND_ANCHORS.right[1]).toBeGreaterThan(0.5);
  });

  test("z 的符号：MediaPipe 的 z 越小越近 ⇒ 映射后 +z 朝相机", () => {
    const landmarks = openHand().map((point) => ({ ...point }));
    landmarks[INDEX_TIP] = { ...landmarks[INDEX_TIP]!, z: -0.05 };
    const base = openHand();
    const options = { mirror: false, extents: { width: 2, height: 2 }, anchor: CENTER };
    const near = projectHand(landmarks, options);
    const far = projectHand(base, options);
    expect(near.joints[INDEX_TIP]![2]).toBeGreaterThan(far.joints[INDEX_TIP]![2]);
  });
});
