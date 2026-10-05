import { describe, expect, test } from "bun:test";
import { HAND_HOLD_MS, createHandDetectionState, interpretDetections, type RawHandDetection } from "./handDetections";
import { PINCH_END_RATIO, PINCH_START_RATIO } from "./handLandmarks";
import { syntheticHandLandmarks } from "./handDebug";

/**
 * 「MediaPipe 一帧」→「场景要用的数据」这一步的三处静默错法（见 `handDetections.ts` 文件头）：
 * 手性误报、平滑历史串手、漏检一帧造成抓取中断。
 */

const detection = (
  options: { center: [number, number]; pinched?: boolean; reported?: "Left" | "Right" | null; score?: number },
): RawHandDetection => ({
  landmarks: syntheticHandLandmarks({ center: options.center, pinched: options.pinched }),
  handedness: options.reported
    ? [{ categoryName: options.reported, score: options.score ?? 0.9 }]
    : [],
});

describe("一帧关键点 → 每只手的平滑状态", () => {
  test("手性按分类判，单只右手放在画面任一侧都仍是右手", () => {
    for (const x of [0.2, 0.5, 0.8]) {
      const hands = interpretDetections([detection({ center: [x, 0.6], reported: "Right" })], createHandDetectionState(), 1000);
      expect(hands[0]!.physical).toBe("right");
    }
  });

  test("手过中线不换身份，也不生成一只宽限期中的假手", () => {
    const state = createHandDetectionState();
    for (const [index, x] of [0.35, 0.45, 0.55, 0.65].entries()) {
      const hands = interpretDetections([detection({ center: [x, 0.6], reported: "Right" })], state, 1000 + index * 16);
      expect(hands.map((hand) => hand.physical)).toEqual(["right"]);
    }
  });

  test("低置信度手性误报由连续位置纠正", () => {
    const state = createHandDetectionState();
    interpretDetections([detection({ center: [0.3, 0.6], reported: "Right" })], state, 1000);
    const hands = interpretDetections([detection({ center: [0.31, 0.6], reported: "Left", score: 0.55 })], state, 1016);
    expect(hands.map((hand) => hand.physical)).toEqual(["right"]);
  });

  test("两手重复标签且检测顺序反转，仍关联到各自历史", () => {
    const state = createHandDetectionState();
    interpretDetections([
      detection({ center: [0.25, 0.6], reported: "Right" }),
      detection({ center: [0.75, 0.6], reported: "Left" }),
    ], state, 1000);
    const hands = interpretDetections([
      detection({ center: [0.74, 0.6], reported: "Right" }),
      detection({ center: [0.26, 0.6], reported: "Right" }),
    ], state, 1016);
    expect(hands[0]!.landmarks[0]!.x).toBeGreaterThan(0.7);
    expect(hands[1]!.landmarks[0]!.x).toBeLessThan(0.3);
  });

  test("三维关键点与图像关键点保持同一身份，漏检时一起保留", () => {
    const state = createHandDetectionState();
    const raw = detection({ center: [0.3, 0.6], reported: "Right" });
    raw.worldLandmarks = raw.landmarks.map((point) => ({ ...point, x: point.x / 10 }));
    const hand = interpretDetections([raw], state, 1000)[0]!;
    expect(hand.worldLandmarks![0]!.x).toBeCloseTo(0.03);
    expect(interpretDetections([], state, 1016)[0]!.worldLandmarks).toEqual(hand.worldLandmarks);
    expect(interpretDetections([], state, 1000 + HAND_HOLD_MS + 1)).toEqual([]);
    expect(state.worldObserved.size).toBe(0);
  });

  test("两只手按物理手分槽，而不是按 MediaPipe 返回的顺序", () => {
    const state = createHandDetectionState();
    // 故意把画面右侧那只（右手）排在数组前面：返回顺序必须按槽位，而不是按输入顺序
    const hands = interpretDetections(
      [
        detection({ center: [0.7, 0.6], reported: "Left" }),
        detection({ center: [0.3, 0.6], reported: "Right" }),
      ],
      state,
      1000,
    );
    expect(hands.map((hand) => hand.physical)).toEqual(["left", "right"]);
    // 左手槽 = 画面右半边那只（原始 x 0.7 → 镜像后 0.3）
    expect(hands[0]!.landmarks[0]!.x).toBeGreaterThan(0.5);
    expect(hands[1]!.landmarks[0]!.x).toBeLessThan(0.5);
  });

  test("平滑历史按手维护：两只手交错出现也不会把关键点串到对方身上", () => {
    const state = createHandDetectionState();
    interpretDetections([detection({ center: [0.7, 0.6], reported: "Left" })], state, 1000);
    const leftFirst = state.smoothed.get("left")![0]!.x;
    // 第二帧只有右手（报 Left）出现，左手在宽限期内沿用上一帧、不该被它污染
    // 第二帧只有**另一只手**（原始 x 0.3 → 镜像后 0.7 = 右手槽）
    const hands = interpretDetections([detection({ center: [0.3, 0.4], reported: "Right" })], state, 1016);
    expect(state.smoothed.get("left")![0]!.x).toBeCloseTo(leftFirst, 12);
    const heldLeft = hands.find((hand) => hand.physical === "left")!;
    expect(heldLeft.landmarks[0]!.x).toBeCloseTo(leftFirst, 12);
    const right = state.smoothed.get("right")!;
    expect(right[0]!.x).toBeCloseTo(0.3, 6);
  });

  test("平滑真的在起作用：第二帧的读数落在两帧之间", () => {
    const state = createHandDetectionState();
    interpretDetections([detection({ center: [0.7, 0.6], reported: "Left" })], state, 1000);
    const first = state.smoothed.get("left")![0]!.x;
    interpretDetections([detection({ center: [0.9, 0.6], reported: "Left" })], state, 1016);
    const second = state.smoothed.get("left")![0]!.x;
    expect(second).toBeGreaterThan(first);
    // α = 0.55：新值约占 55%
    expect(second).toBeCloseTo(first + 0.2 * 0.55, 1);
    expect(second).toBeLessThan(first + 0.2);
  });

  test("模型没给手性（handedness 为空）时按序号兜底，绝不丢手", () => {
    const state = createHandDetectionState();
    const hands = interpretDetections([detection({ center: [0.6, 0.6], reported: null })], state, 1000);
    expect(hands).toHaveLength(1);
    expect(hands[0]!.physical).toBe("left");
  });

  test("点数不对或含 NaN 的那只手整个丢掉（不能拿它去渲染）", () => {
    const state = createHandDetectionState();
    const broken: RawHandDetection = {
      landmarks: syntheticHandLandmarks({ center: [0.5, 0.5] }).map((point, index) =>
        index === 3 ? { ...point, y: Number.NaN } : point,
      ),
      handedness: [{ categoryName: "Left", score: 1 }],
    };
    expect(interpretDetections([broken], state, 1000)).toHaveLength(0);
    expect(interpretDetections([{ landmarks: [], handedness: [] }], state, 1000)).toHaveLength(0);
  });
});

describe("捏合状态", () => {
  test("捏住的手报 pinching，同时给出比值", () => {
    const state = createHandDetectionState();
    const hands = interpretDetections(
      [detection({ center: [0.5, 0.5], pinched: true, reported: "Left" })],
      state,
      1000,
    );
    expect(hands[0]!.pinching).toBe(true);
    expect(hands[0]!.pinchRatio).toBeLessThan(PINCH_START_RATIO);
  });

  test("捏合状态跨帧保留（迟滞），张开之后才松开", () => {
    const state = createHandDetectionState();
    const pinched = detection({ center: [0.5, 0.5], pinched: true, reported: "Left" });
    const open = detection({ center: [0.5, 0.5], reported: "Left" });
    expect(interpretDetections([pinched], state, 1000)[0]!.pinching).toBe(true);
    // 同一个状态机留着：又一次捏合（迟滞状态是"捏住"）仍然是捏住
    expect(interpretDetections([pinched], state, 1032)[0]!.pinching).toBe(true);
    // 张开（比值 > PINCH_END_RATIO）才真的松开
    const opened = interpretDetections([open], state, 1048);
    expect(opened[0]!.pinching).toBe(false);
    expect(opened[0]!.pinchRatio).toBeGreaterThan(PINCH_END_RATIO);
  });
});

describe("漏检宽限", () => {
  test("一帧没检测到仍按「还在」对待，且保持捏合状态（抓着的东西不会掉）", () => {
    const state = createHandDetectionState();
    interpretDetections([detection({ center: [0.5, 0.5], pinched: true, reported: "Left" })], state, 1000);
    const held = interpretDetections([], state, 1000 + HAND_HOLD_MS - 1);
    expect(held).toHaveLength(1);
    expect(held[0]!.pinching).toBe(true);
  });

  test("超过宽限就真的离开，并且清掉历史（再出现时不会从陈旧位置滑过来）", () => {
    const state = createHandDetectionState();
    interpretDetections([detection({ center: [0.5, 0.5], reported: "Left" })], state, 1000);
    expect(interpretDetections([], state, 1000 + HAND_HOLD_MS + 1)).toHaveLength(0);
    expect(state.smoothed.has("left")).toBe(false);
    expect(state.lastSeen.has("left")).toBe(false);
    // 重新出现时是第一帧（原样采用，不插值）
    const again = interpretDetections([detection({ center: [0.9, 0.2], reported: "Left" })], state, 2000);
    // 第一帧原样采用（腕的模板 x 是 0，所以就是 center 的 x）
    expect(again[0]!.landmarks[0]!.x).toBeCloseTo(0.9, 6);
  });
});
