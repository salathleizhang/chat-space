import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  CHARACTER_EYE_OFFSET,
  CHARACTER_HEIGHT,
  CHARACTER_RADIUS,
  GRAB_LINEAR_LIMIT,
  PHYSICS_GROUND_HALF_EXTENT,
  PHYSICS_GROUND_THICKNESS,
  PHYSICS_SAFETY_NET_Y,
  RUN_SPEED,
  WALK_SPEED,
  boxColliderFromBounds,
  characterCapsule,
  clampVelocity,
  dragVelocity,
  horizontalVelocity,
  needsPhysicsFrames,
  physicsEnabledFromSearch,
  placementMoved,
} from "./physics";

describe("physics/角色尺寸", () => {
  test("胶囊体与眼高自洽：总高就是 CHARACTER_HEIGHT", () => {
    const { halfSegment, radius } = characterCapsule();
    expect(radius).toBe(CHARACTER_RADIUS);
    // CapsuleCollider 的总高 = 2 * (圆柱半长 + 半径)
    expect(2 * (halfSegment + radius)).toBeCloseTo(CHARACTER_HEIGHT, 10);
    expect(halfSegment).toBeCloseTo(0.55, 10);
  });

  test("眼高是身高的一半（原 FirstPersonRig 的 EYE_HEIGHT 口径）", () => {
    expect(CHARACTER_EYE_OFFSET).toBeCloseTo(0.8, 10);
    expect(CHARACTER_EYE_OFFSET).toBeCloseTo(CHARACTER_HEIGHT / 2, 10);
  });
});

describe("physics/盒体碰撞体", () => {
  test("从真实 Box3 取半尺寸与中心", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -2), new THREE.Vector3(1, 3, 2));
    const { halfExtents, center } = boxColliderFromBounds(box);
    expect(halfExtents).toEqual([1, 1.5, 2]);
    expect(center).toEqual([0, 1.5, 0]);
  });

  test("中心不在原点时不会被抹平", () => {
    const box = new THREE.Box3(new THREE.Vector3(4, 5, 6), new THREE.Vector3(5, 6, 7));
    const { halfExtents, center } = boxColliderFromBounds(box);
    expect(halfExtents).toEqual([0.5, 0.5, 0.5]);
    expect(center).toEqual([4.5, 5.5, 6.5]);
  });

  test("退化盒体（零厚度）钳到最小边长，不产生零尺寸碰撞体", () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 2));
    const { halfExtents } = boxColliderFromBounds(box);
    expect(halfExtents[1]).toBe(0.01);
    expect(halfExtents[0]).toBe(1);
  });
});

describe("physics/水平速度与三的朝向约定", () => {
  test.each([0, Math.PI / 2, Math.PI, -Math.PI / 3, 2.4])(
    "yaw=%p 与真实四元数推到的一致",
    (yaw) => {
      const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, "YXZ"));
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).setY(0).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).setY(0).normalize();

      const [fx, fz] = horizontalVelocity(1, 0, yaw, 1);
      const [rx, rz] = horizontalVelocity(0, 1, yaw, 1);

      expect(fx).toBeCloseTo(forward.x, 10);
      expect(fz).toBeCloseTo(forward.z, 10);
      expect(rx).toBeCloseTo(right.x, 10);
      expect(rz).toBeCloseTo(right.z, 10);
    },
  );

  test("按速度缩放，且斜向不超速（对角归一）", () => {
    const [walkX, walkZ] = horizontalVelocity(1, 0, 0, WALK_SPEED);
    expect(Math.hypot(walkX, walkZ)).toBeCloseTo(WALK_SPEED, 10);

    const [diagX, diagZ] = horizontalVelocity(1, 1, 0, RUN_SPEED);
    expect(Math.hypot(diagX, diagZ)).toBeCloseTo(RUN_SPEED, 10);
  });
});

describe("physics/速度钳制与甩出", () => {
  test("超限时按比例缩到上限", () => {
    const clamped = clampVelocity([3, 4, 0], 2);
    expect(Math.hypot(...clamped)).toBeCloseTo(2, 10);
    expect(clamped[0]).toBeCloseTo(1.2, 10);
    expect(clamped[1]).toBeCloseTo(1.6, 10);
  });

  test("不超限时原样返回（不额外归一）", () => {
    expect(clampVelocity([0.1, 0.2, 0.3], 5)).toEqual([0.1, 0.2, 0.3]);
  });

  test("甩出速度 = 位移/步长，并钳到上限", () => {
    expect(dragVelocity([0, 0, 0], [0.5, 0, 0], 0.5, GRAB_LINEAR_LIMIT)).toEqual([1, 0, 0]);

    const thrown = dragVelocity([0, 0, 0], [50, 0, 0], 0.01, GRAB_LINEAR_LIMIT);
    expect(thrown[0]).toBeCloseTo(GRAB_LINEAR_LIMIT, 10);
  });

  test("dt<=0 时返回零速度而不是 Infinity/NaN", () => {
    expect(dragVelocity([0, 0, 0], [1, 2, 3], 0, GRAB_LINEAR_LIMIT)).toEqual([0, 0, 0]);
    expect(dragVelocity([0, 0, 0], [1, 2, 3], -1, GRAB_LINEAR_LIMIT)).toEqual([0, 0, 0]);
  });
});

describe("physics/续帧判据", () => {
  test("三者都不成立时必须不要帧（否则 demand 循环退化成常驻 60fps）", () => {
    expect(needsPhysicsFrames({ characterActive: false, grabbing: false, awakeBodies: 0 })).toBe(false);
  });

  test("任意一条成立就要帧", () => {
    expect(needsPhysicsFrames({ characterActive: true, grabbing: false, awakeBodies: 0 })).toBe(true);
    expect(needsPhysicsFrames({ characterActive: false, grabbing: true, awakeBodies: 0 })).toBe(true);
    expect(needsPhysicsFrames({ characterActive: false, grabbing: false, awakeBodies: 1 })).toBe(true);
  });
});

describe("physics/摆放与刚体是否已分开", () => {
  const base = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };

  test("完全相同 → 不需要 teleport", () => {
    expect(placementMoved(base, base)).toBe(false);
  });

  test("位置位移超过阈值 → 需要 teleport", () => {
    expect(placementMoved(base, { ...base, position: [1.5, 2, 3] })).toBe(true);
  });

  test("噪声级位移（<1e-4）不算动过", () => {
    expect(placementMoved(base, { ...base, position: [1 + 1e-6, 2, 3] })).toBe(false);
  });

  test("q 与 -q 是同一个旋转，不能判成动了", () => {
    const flipped = { ...base, rotation: [0, 0, 0, -1] as [number, number, number, number] };
    expect(placementMoved(base, flipped)).toBe(false);
  });

  test("真实旋转变化会被抓到", () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
    const rotated = { ...base, rotation: [q.x, q.y, q.z, q.w] as [number, number, number, number] };
    expect(placementMoved(base, rotated)).toBe(true);
  });
});

describe("physics/地面平板", () => {
  test("顶面在 y=0（world 的 groundPlaneOffset 语义就是把地面抬到 0）", () => {
    // 平板中心下沉一个厚度 ⇒ 顶面恰好 0。写成断言是因为"顶面在 0"这个不变量
    // 被 spawn（y = 眼高 + 0.2）和摆放在 y=0 的资产同时依赖着。
    const top = -PHYSICS_GROUND_THICKNESS + PHYSICS_GROUND_THICKNESS;
    expect(top).toBe(0);
    expect(PHYSICS_GROUND_HALF_EXTENT).toBeGreaterThanOrEqual(50);
  });

  test("安全网在地面之下足够深，且深于任何正常摆放", () => {
    expect(PHYSICS_SAFETY_NET_Y).toBeLessThan(-5);
    expect(PHYSICS_SAFETY_NET_Y).toBeGreaterThan(-50);
  });
});

describe("physics/A-B 开关", () => {
  test("默认开启：不带参数、或带别的参数时都是开", () => {
    expect(physicsEnabledFromSearch("")).toBe(true);
    expect(physicsEnabledFromSearch("?pcViewport=1&pcDebug=1")).toBe(true);
  });

  test("只有显式 physics=0 才关（给测量做对照臂）", () => {
    expect(physicsEnabledFromSearch("?physics=0")).toBe(false);
    expect(physicsEnabledFromSearch("?pcDebug=1&physics=0")).toBe(false);
    expect(physicsEnabledFromSearch("?physics=0&pcDebug=1")).toBe(false);
  });

  test("physics=00 / physics=01 这类不算关：判据必须是精确值", () => {
    expect(physicsEnabledFromSearch("?physics=00")).toBe(true);
    expect(physicsEnabledFromSearch("?physics=01")).toBe(true);
  });
});
