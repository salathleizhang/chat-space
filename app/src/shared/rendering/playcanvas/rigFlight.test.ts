import { describe, expect, test } from "bun:test";
import { rigPosition, type CameraRig } from "../../../shared/lib/cameraRig";
import {
  ARRIVE_DISTANCE_SQ, createRigFlight, DAMP_LAMBDA, damp, flightStep, rigFromPose, rigPose,
} from "./rigFlight";

const rig = (over: Partial<CameraRig> = {}): CameraRig => ({
  target: [0, 0, 0], azimuth: 0, polar: Math.PI / 2, distance: 10, fov: 60, projection: "perspective", ...over,
});

describe("位姿 ↔ 台架（互为逆运算）", () => {
  test("rigPose 用 rigPosition 的正向定义", () => {
    const pose = rigPose(rig({ target: [1, 2, 3], azimuth: 0.7, polar: 1.1, distance: 4 }));
    expect(pose.target).toEqual([1, 2, 3]);
    expect(pose.position[0]).toBeCloseTo(rigPosition(rig({ target: [1, 2, 3], azimuth: 0.7, polar: 1.1, distance: 4 }))[0], 9);
  });

  test("反解回来得到同一个台架（方位角/极角/距离、fov/projection 保留）", () => {
    const original = rig({ target: [1, 2, 3], azimuth: 0.7, polar: 1.1, distance: 4, fov: 45 });
    const back = rigFromPose(rigPose(original), rig({ fov: 45 }));
    expect(back.target).toEqual(original.target);
    expect(back.azimuth).toBeCloseTo(original.azimuth, 9);
    expect(back.polar).toBeCloseTo(original.polar, 9);
    expect(back.distance).toBeCloseTo(original.distance, 9);
    expect(back.fov).toBe(45);
    // 正交也一样
    const ortho = rig({ projection: "orthographic", distance: 42 });
    expect(rigFromPose(rigPose(ortho), ortho).projection).toBe("orthographic");
  });

  test("退化位姿（位置与目标点重合）不产生 NaN", () => {
    const degenerate = rigFromPose({ position: [1, 2, 3], target: [1, 2, 3] }, rig());
    expect(Number.isFinite(degenerate.azimuth)).toBe(true);
    expect(Number.isFinite(degenerate.polar)).toBe(true);
    expect(degenerate.target).toEqual([1, 2, 3]);
  });

  test("极角在反解时被钳到开区间（正上/正下不会与 up 共线）", () => {
    expect(rigFromPose({ position: [0, 5, 0], target: [0, 0, 0] }, rig()).polar).toBeCloseTo(0.01, 12);
    expect(rigFromPose({ position: [0, -5, 0], target: [0, 0, 0] }, rig()).polar).toBeCloseTo(Math.PI - 0.01, 12);
  });
});

describe("指数阻尼与飞一步", () => {
  test("damp 与 three 的 MathUtils.damp 同式；delta 非正不动", () => {
    expect(damp(0, 10, DAMP_LAMBDA, 0.25)).toBeCloseTo(10 * (1 - Math.exp(-1)), 12);
    expect(damp(3, 10, DAMP_LAMBDA, 0)).toBe(3);
    expect(damp(3, 10, DAMP_LAMBDA, -1)).toBe(3);
    // 单调靠近、永不过冲
    let value = 0;
    for (let i = 0; i < 20; i += 1) value = damp(value, 10, DAMP_LAMBDA, 0.05);
    expect(value).toBeLessThan(10);
  });

  test("flightStep：位置与目标点一起收敛，到位后直接吸附到目标（不留浮点尾巴）", () => {
    const from = rigPose(rig({ target: [0, 0, 0], azimuth: 0, polar: Math.PI / 2, distance: 10 }));
    const to = rigPose(rig({ target: [3, 1, -2], azimuth: 1.2, polar: 1.0, distance: 4 }));
    const first = flightStep(from, to, 1 / 60);
    expect(first.arrived).toBe(false);
    // 距离在缩小
    const before = Math.hypot(from.position[0] - to.position[0], from.position[1] - to.position[1], from.position[2] - to.position[2]);
    const after = Math.hypot(first.pose.position[0] - to.position[0], first.pose.position[1] - to.position[1], first.pose.position[2] - to.position[2]);
    expect(after).toBeLessThan(before);

    let pose = from;
    let arrived = false;
    for (let i = 0; i < 2000 && !arrived; i += 1) {
      const step = flightStep(pose, to, 1 / 60);
      pose = step.pose;
      arrived = step.arrived;
    }
    expect(arrived).toBe(true);
    expect(pose.position).toEqual(to.position);
    expect(pose.target).toEqual(to.target);
  });

  test("到位判据是位置距离平方（阈值与 three 侧同值）", () => {
    const to = rigPose(rig({ distance: 10 }));
    const near = rigPose(rig({ distance: 10 + Math.sqrt(ARRIVE_DISTANCE_SQ) / 2 }));
    expect(flightStep(near, to, 1 / 60).arrived).toBe(true);
    expect(ARRIVE_DISTANCE_SQ).toBe(0.0004);
  });
});

describe("飞行器（逐帧推进）", () => {
  function fixture() {
    let current: CameraRig | null = rig({ distance: 10 });
    const applied: CameraRig[] = [];
    let ticker: ((deltaMs: number) => void) | null = null;
    const handle = createRigFlight({
      apply: (_paneId, next) => { current = next; applied.push(next); },
      read: () => current,
      subscribe: (tick) => { ticker = tick; return () => { ticker = null; }; },
    });
    return {
      handle, applied, ticker: () => ticker,
      current: () => current,
      setCurrent: (next: CameraRig | null) => { current = next; },
      tick: (deltaMs: number) => ticker?.(deltaMs),
    };
  }

  test("start 之后逐帧推进、到位即停并退订", () => {
    const f = fixture();
    const destination = rig({ target: [2, 1, 0], azimuth: 0.9, polar: 1.2, distance: 5 });
    expect(f.handle.start("pane-0", destination)).toBe(true);
    expect(f.handle.flying()).toBe(true);
    for (let i = 0; i < 300 && f.handle.flying(); i += 1) f.tick(16);
    expect(f.handle.flying()).toBe(false);
    expect(f.handle.stats().arrived).toBe(true);
    expect(f.applied.length).toBeGreaterThan(3);
    expect(f.applied.at(-1)!.distance).toBeCloseTo(5, 9);
    expect(f.ticker()).toBeNull(); // 到位后退订，静止时不再有每帧回调
  });

  test("cancel 立刻停（用户一有输入就该调它）", () => {
    const f = fixture();
    f.handle.start("pane-0", rig({ distance: 3 }));
    f.tick(16);
    const applied = f.applied.length;
    f.handle.cancel();
    expect(f.handle.flying()).toBe(false);
    f.tick(16);
    expect(f.applied.length).toBe(applied);
  });

  test("没有台架时不飞；飞行途中台架被销毁也自己收手", () => {
    const f = fixture();
    f.setCurrent(null);
    expect(f.handle.start("pane-0", rig())).toBe(false);
    f.setCurrent(rig());
    f.handle.start("pane-0", rig({ distance: 3 }));
    f.setCurrent(null);
    f.tick(16);
    expect(f.handle.flying()).toBe(false);
  });

  test("每帧重新读当前台架：用户在飞行途中手改的姿势不会被覆盖回起点", () => {
    const f = fixture();
    f.handle.start("pane-0", rig({ target: [0, 0, 0], distance: 3 }));
    f.tick(16);
    // 用户中途把目标点挪走：下一帧应当从**新**目标点继续收敛
    f.setCurrent({ ...f.current()!, target: [5, 0, 0] });
    f.tick(16);
    expect(f.applied.at(-1)!.target[0]).toBeGreaterThan(0);
  });

  test("dispose 之后不再推进（幂等）", () => {
    const f = fixture();
    f.handle.start("pane-0", rig({ distance: 3 }));
    f.handle.dispose();
    f.handle.dispose();
    expect(f.handle.flying()).toBe(false);
    expect(f.ticker()).toBeNull();
  });
});
