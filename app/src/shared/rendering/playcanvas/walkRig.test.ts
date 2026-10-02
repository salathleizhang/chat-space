import { describe, expect, test } from "bun:test";
import {
  createWalkState, EYE_HEIGHT, lookStep, MAX_FRAME_DELTA, MAX_PITCH, RUN_SPEED, walkForward,
  walkInputFromKeys, walkStep, WALK_SPEED, WALK_START, type WalkState,
} from "./walkRig";

const state = (over: Partial<WalkState> = {}): WalkState => createWalkState(over);

describe("第一人称漫游的纯数学", () => {
  test("初始机位与眼睛高度（three 侧同值）", () => {
    expect(EYE_HEIGHT).toBe(1.6);
    expect(WALK_START).toEqual([0, 1.6, 3]);
    const start = state();
    expect(start.position).toEqual([0, 1.6, 3]);
    expect([start.yaw, start.pitch]).toEqual([0, 0]);
  });

  test("偏航 0 看向 -Z；偏航 +90° 看向 -X；俯仰改变竖直分量", () => {
    const [x0, y0, z0] = walkForward({ yaw: 0, pitch: 0 });
    expect(x0).toBeCloseTo(0, 12);
    expect(y0).toBeCloseTo(0, 12);
    expect(z0).toBeCloseTo(-1, 12);
    const [x1, , z1] = walkForward({ yaw: Math.PI / 2, pitch: 0 });
    expect(x1).toBeCloseTo(-1, 12);
    expect(z1).toBeCloseTo(0, 12);
    expect(walkForward({ yaw: 0, pitch: Math.PI / 4 })[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  test("WASD：前后沿水平朝向、横移与地面平行；高度恒为眼睛高度", () => {
    const forward = walkStep(state({ yaw: 0 }), { forward: 1, strafe: 0, run: false, delta: 1 });
    // 注意 three 侧也把单帧 delta 钳到 0.1 s，所以 1 秒只走 0.1 秒的距离
    expect(forward.position[2]).toBeCloseTo(WALK_START[2] - WALK_SPEED * MAX_FRAME_DELTA, 9);
    expect(forward.position[1]).toBe(EYE_HEIGHT);
    const back = walkStep(state(), { forward: -1, strafe: 0, run: false, delta: 0.1 });
    expect(back.position[2]).toBeGreaterThan(WALK_START[2]);
    // 向右横移：朝向 -Z 时右向是 +X（three 侧 right = forward × up）
    const strafe = walkStep(state(), { forward: 0, strafe: 1, run: false, delta: 0.1 });
    expect(strafe.position[0]).toBeCloseTo(WALK_SPEED * 0.1, 9);
    expect(strafe.position[2]).toBeCloseTo(WALK_START[2], 9);
  });

  test("俯仰不影响水平移动距离（不会往地里钻或飞起来）", () => {
    const flat = walkStep(state({ pitch: 0 }), { forward: 1, strafe: 0, run: false, delta: 0.1 });
    const up = walkStep(state({ pitch: MAX_PITCH }), { forward: 1, strafe: 0, run: false, delta: 0.1 });
    expect(Math.hypot(up.position[0] - 0, up.position[2] - WALK_START[2]))
      .toBeCloseTo(Math.hypot(flat.position[0] - 0, flat.position[2] - WALK_START[2]), 9);
    expect(up.position[1]).toBe(EYE_HEIGHT);
  });

  test("Shift 加速：RUN_SPEED 是 WALK_SPEED 的倍数，且单帧步长钳在 0.1 s", () => {
    const walk = walkStep(state(), { forward: 1, strafe: 0, run: false, delta: 10 });
    const run = walkStep(state(), { forward: 1, strafe: 0, run: true, delta: 10 });
    expect(WALK_START[2] - walk.position[2]).toBeCloseTo(WALK_SPEED * MAX_FRAME_DELTA, 9);
    expect(WALK_START[2] - run.position[2]).toBeCloseTo(RUN_SPEED * MAX_FRAME_DELTA, 9);
    expect(RUN_SPEED).toBeGreaterThan(WALK_SPEED);
  });

  test("不动时也把高度锁回去（相机被别的东西挪过时）", () => {
    const lifted = state({ position: [1, 5, 1] });
    const still = walkStep(lifted, { forward: 0, strafe: 0, run: false, delta: 0.1 });
    expect(still.position).toEqual([1, EYE_HEIGHT, 1]);
    // 但位置已经在眼睛高度时返回同一个对象（不产生无谓的写入）
    const same = state();
    expect(walkStep(same, { forward: 0, strafe: 0, run: false, delta: 0.1 })).toBe(same);
  });

  test("视角：俯仰钳在 ±(π/2 - 0.01)，偏航可以无限绕", () => {
    expect(lookStep(state(), 0, 100).pitch).toBeCloseTo(MAX_PITCH, 12);
    expect(lookStep(state(), 0, -100).pitch).toBeCloseTo(-MAX_PITCH, 12);
    expect(lookStep(state(), 100, 0).yaw).toBeCloseTo(100, 12);
    // 非法增量不动
    const before = state();
    expect(lookStep(before, Number.NaN, 1)).toBe(before);
  });

  test("按键集合 → 输入：只认小写，Shift 是加速键", () => {
    expect(walkInputFromKeys(new Set(["w", "shift"]), 0.016)).toEqual({ forward: 1, strafe: 0, run: true, delta: 0.016 });
    expect(walkInputFromKeys(new Set(["w", "s", "a", "d"]), 0.016)).toEqual({ forward: 0, strafe: 0, run: false, delta: 0.016 });
    expect(walkInputFromKeys(new Set(["W"]), 0.016).forward).toBe(0); // 大写不认（three 侧转小写后才进集合）
    expect(walkInputFromKeys(new Set(["s", "a", "shift"]), 0.016)).toEqual({ forward: -1, strafe: -1, run: true, delta: 0.016 });
  });
});
