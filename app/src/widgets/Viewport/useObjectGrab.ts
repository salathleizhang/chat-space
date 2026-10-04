import { useThree } from "@react-three/fiber";
import { useBeforePhysicsStep, useRapier, type RapierRigidBody } from "@react-three/rapier";
import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import {
  GRAB_ANGULAR_LIMIT,
  GRAB_LINEAR_LIMIT,
  GRAB_MAX_DISTANCE,
  clampVelocity,
  dragVelocity,
} from "./physics";
import { isForcedLocked } from "./physicsDebug";

const _origin = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _inverse = new THREE.Quaternion();
const _offset = new THREE.Vector3();

interface ActiveGrab {
  body: RapierRigidBody;
  joint: ReturnType<ReturnType<typeof useRapier>["world"]["createImpulseJoint"]>;
  /** 抓取点到相机的距离；拖拽时目标点 = 相机 + 视线 × depth */
  depth: number;
  previous: [number, number, number];
  release: [number, number, number];
}

function isCharacter(body: RapierRigidBody | null): boolean {
  if (!body) return false;
  return (body.userData as { character?: boolean } | null)?.character === true;
}

/**
 * 第一人称下的**准星抓取**：点住左键把面前的物体"粘"在视线方向上，松手带速度甩出。
 *
 * 与 image-blaster 同构（kinematic 锚点 + spherical impulse joint + 松手给速度），
 * 但取物方式换成了**屏幕中心**的射线而不是鼠标坐标：指针锁定时鼠标本来就被钉在中心，
 * 而 three 侧的拾取代理（`PanePickTarget`）在第一人称下**整棵都不挂**（没有窗格就没有
 * pick target），所以这里直接用 rapier 自己的 raycast——它查的是碰撞体，恰好就是
 * "能不能抓到"的判据本身。
 *
 * 三条纪律：
 * 1. **射线排除角色自己**（`userData.character`），否则准星永远先命中自己的胶囊体；
 * 2. **只抓 dynamic 刚体**：世界地形是 fixed、`static` 物体也是 fixed，抓它们等于抓空气；
 * 3. **每步都钳速度**（线 5 / 角 10）：不钳的话"把物体拖进墙里"会让解算器给出爆炸速度，
 *    物体会以肉眼看不到的速度飞出场景（与 image-blaster 的 clampBodyVelocity 同参数）。
 */
export function useObjectGrab({ enabled }: { enabled: boolean }) {
  const camera = useThree((state) => state.camera);
  const { rapier, world } = useRapier();
  const anchorRef = useRef<RapierRigidBody | null>(null);
  const activeRef = useRef<ActiveGrab | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const ensureAnchor = useCallback((): RapierRigidBody => {
    if (!anchorRef.current) {
      anchorRef.current = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased());
    }
    return anchorRef.current;
  }, [rapier, world]);

  const release = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    try {
      world.removeImpulseJoint(active.joint, true);
    } catch {
      // 世界可能正在重建（资产换修订号、布局切换），陈旧关节忽略即可
    }
    try {
      active.body.setLinvel({ x: active.release[0], y: active.release[1], z: active.release[2] }, true);
      active.body.wakeUp();
    } catch {
      // 刚体可能已经被卸载
    }
  }, [world]);

  const tryGrab = useCallback(() => {
    if (!enabledRef.current || activeRef.current) return;
    // 没锁定指针时这一下点击是"进入第一人称"，不该顺手抓一个东西。
    // 沙箱拿不到真指针锁定时由诊断口的 forceInput 顶替（见 physicsDebug.ts）。
    if (
      !isForcedLocked()
      && typeof document !== "undefined"
      && document.pointerLockElement === null
    ) {
      return;
    }

    camera.getWorldPosition(_origin);
    camera.getWorldDirection(_forward).normalize();

    const ray = new rapier.Ray(
      { x: _origin.x, y: _origin.y, z: _origin.z },
      { x: _forward.x, y: _forward.y, z: _forward.z },
    );
    const hit = world.castRay(
      ray,
      GRAB_MAX_DISTANCE,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (collider) => {
        const body = collider.parent();
        return Boolean(body && body.isDynamic() && !isCharacter(body));
      },
    );
    if (!hit) return;

    const body = hit.collider.parent();
    if (!body || !body.isDynamic() || isCharacter(body)) return;

    const depth = hit.timeOfImpact;
    const point = {
      x: _origin.x + _forward.x * depth,
      y: _origin.y + _forward.y * depth,
      z: _origin.z + _forward.z * depth,
    };

    const anchor = ensureAnchor();
    anchor.setTranslation(point, true);
    anchor.setNextKinematicTranslation(point);

    // 关节锚点写在**物体局部坐标系**里：世界点减去刚体位置再转进它的姿态
    const translation = body.translation();
    const rotation = body.rotation();
    _inverse.set(rotation.x, rotation.y, rotation.z, rotation.w).invert();
    _offset.set(point.x - translation.x, point.y - translation.y, point.z - translation.z);
    _offset.applyQuaternion(_inverse);

    const joint = world.createImpulseJoint(
      rapier.JointData.spherical(
        { x: 0, y: 0, z: 0 },
        { x: _offset.x, y: _offset.y, z: _offset.z },
      ),
      anchor,
      body,
      true,
    );

    body.wakeUp();
    activeRef.current = {
      body,
      joint,
      depth,
      previous: [point.x, point.y, point.z],
      release: [0, 0, 0],
    };
  }, [camera, ensureAnchor, rapier, world]);

  useBeforePhysicsStep((physicsWorld) => {
    const active = activeRef.current;
    const anchor = anchorRef.current;
    if (!active || !anchor) return;

    camera.getWorldPosition(_origin);
    camera.getWorldDirection(_forward).normalize();
    const target: [number, number, number] = [
      _origin.x + _forward.x * active.depth,
      _origin.y + _forward.y * active.depth,
      _origin.z + _forward.z * active.depth,
    ];

    const timestep = physicsWorld.timestep || 1 / 60;
    active.release = dragVelocity(active.previous, target, timestep, GRAB_LINEAR_LIMIT);
    active.previous = target;
    anchor.setNextKinematicTranslation({ x: target[0], y: target[1], z: target[2] });

    const linear = active.body.linvel();
    const clampedLinear = clampVelocity([linear.x, linear.y, linear.z], GRAB_LINEAR_LIMIT);
    active.body.setLinvel(
      { x: clampedLinear[0], y: clampedLinear[1], z: clampedLinear[2] },
      true,
    );
    const angular = active.body.angvel();
    const clampedAngular = clampVelocity([angular.x, angular.y, angular.z], GRAB_ANGULAR_LIMIT);
    active.body.setAngvel(
      { x: clampedAngular[0], y: clampedAngular[1], z: clampedAngular[2] },
      true,
    );
  });

  useEffect(() => {
    if (!enabled) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      tryGrab();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      release();
    };
    const onCancel = () => release();

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onCancel);
    // 退出指针锁定（Esc）时必须松手：不松的话物体被永久吊在相机前面
    document.addEventListener("pointerlockchange", onCancel);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("pointerlockchange", onCancel);
      release();
    };
  }, [enabled, release, tryGrab]);

  useEffect(() => {
    return () => {
      release();
      const anchor = anchorRef.current;
      anchorRef.current = null;
      if (!anchor) return;
      try {
        world.removeRigidBody(anchor);
      } catch {
        // 世界已经销毁
      }
    };
  }, [release, world]);

  /** 交给调用方的不只是"能不能抓"，还有诊断口要用的同一批函数（见 physicsDebug.ts） */
  return { tryGrab, release, isGrabbing: () => activeRef.current !== null };
}
