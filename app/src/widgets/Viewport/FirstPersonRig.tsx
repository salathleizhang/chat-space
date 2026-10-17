import { PointerLockControls } from "@react-three/drei/core/PointerLockControls";
import {
  CapsuleCollider,
  RigidBody,
  useAfterPhysicsStep,
  useBeforePhysicsStep,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type ComponentRef } from "react";
import * as THREE from "three";
import {
  CHARACTER_EYE_OFFSET,
  GROUND_PROBE_DISTANCE,
  JUMP_VELOCITY,
  RUN_SPEED,
  WALK_SPEED,
  characterCapsule,
  horizontalVelocity,
} from "./physics";
import { DEFAULT_FIRST_PERSON_ENTRY, type FirstPersonEntry } from "./firstPersonEntry";
import { isForcedLocked } from "./physicsDebug";

const _direction = new THREE.Vector3();
/** 进场时写朝向用的临时欧拉（每次新建也无所谓，但没必要在 effect 里分配） */
const _entryEuler = new THREE.Euler(0, 0, 0, "YXZ");

/**
 * 「焦点在输入框里」判定：与 G/R/S 契约（`transformKeys.ts`）同一口径。
 * 没锁指针时用户多半正在 Agent 输入框里打字，那时 WASD 绝不能推着角色走。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const element = target as { isContentEditable?: boolean; tagName?: string };
  if (element.isContentEditable) return true;
  return /^(input|textarea|select)$/i.test(element.tagName ?? "");
}

/**
 * 第一人称：**物理驱动**的胶囊体 + 指针锁定视角。
 *
 * 与改造前的区别只有一处，但它是这次改动的全部意义：以前每帧硬写
 * `camera.position.y = EYE_HEIGHT`，所以"走"其实是在空气里平移——不撞墙、不上台阶、
 * 不掉下去。现在相机只是**读出**刚体位置，脚在哪由 rapier 说了算。
 *
 * 三个必须踩住的点：
 * 1. **速度写在 `useBeforePhysicsStep`，位置读在 `useAfterPhysicsStep`**。
 *    `<Physics>` 用 `updateLoop="independent"`（专为 `frameloop="demand"` 设计），
 *    物理步与渲染帧**不是一个节奏**；写在 `useFrame` 里会按渲染帧改速度、按物理步前进，
 *    手感随帧率漂移。
 * 2. **`RigidBody` 必须禁用旋转**（`enabledRotations={[false,false,false]}`），否则胶囊体
 *    撞到东西会像滚筒一样翻滚，相机跟着翻。
 * 3. **跳跃要先探地**：没落地的"二段跳"是最常见的物理角色 bug，这里用一条从刚体中心
 *    向下的射线（排除自身）判定。排除自身不是可选项——不排除时第一个命中的永远是自己的
 *    胶囊体，判据恒真。
 *
 * 键位沿用产品原有手感（WASD/方向键 + Shift 加速），跳跃是这次新增的 Space。
 */
export function FirstPersonRig({
  lockSelector,
  entry = DEFAULT_FIRST_PERSON_ENTRY,
}: {
  /** 指针锁定的点击选择器（见 `FIRST_PERSON_LOCK_SELECTOR`） */
  lockSelector: string;
  /**
   * 进场状态：出生点（**刚体中心**）+ 初始朝向。进模式那一刻由当前透视窗格的机位推出
   * （见 `firstPersonEntry.ts`），所以"进去"是从用户刚才看的地方、朝刚才那个方向续上，
   * 而不是跳到一个固定位置。
   */
  entry?: FirstPersonEntry;
}) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const { rapier, world } = useRapier();
  const bodyRef = useRef<RapierRigidBody | null>(null);
  const controlsRef = useRef<ComponentRef<typeof PointerLockControls>>(null);
  const keys = useRef<Set<string>>(new Set());
  const jumpQueued = useRef(false);
  const capsule = useMemo(characterCapsule, []);
  const { spawn, yaw, pitch } = entry;

  useEffect(() => {
    camera.position.set(spawn[0], spawn[1], spawn[2]);
    /*
      朝向也要在这里写一次。`PointerLockControls` **自己不留**视角状态：它每次鼠标移动都
      从相机当前四元数反解再叠加（`_euler.setFromQuaternion(camera.quaternion)`），所以
      只要进场时把相机摆成"当前机位那个朝向"，进去之后转头的起点就是连续的。
      `up` 显式写回 (0,1,0)：这台根画布相机上一轮可能被别的模式动过，而 YXZ 分解要求上方向
      是 +Y，否则会出现滚转。
    */
    camera.up.set(0, 1, 0);
    camera.quaternion.setFromEuler(_entryEuler.set(pitch, yaw, 0, "YXZ"));
    invalidate();
  }, [camera, spawn, yaw, pitch, invalidate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 未锁定时用户可能正在 Agent 输入框里打字，WASD 绝不能偷偷推着角色走
      if (isEditableTarget(event.target)) return;
      keys.current.add(event.code);
      if (event.code === "Space" && !event.repeat) {
        jumpQueued.current = true;
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keys.current.delete(event.code);
    // 失焦（切标签页、切窗口）时按键集合必须清空，否则回来时角色会"自己一直往前走"
    const onBlur = () => {
      keys.current.clear();
      jumpQueued.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      keys.current.clear();
    };
  }, []);

  useBeforePhysicsStep(() => {
    const body = bodyRef.current;
    if (!body) return;

    const locked = (controlsRef.current?.isLocked ?? false) || isForcedLocked();
    const pressed = keys.current;
    const forward =
      (pressed.has("KeyW") || pressed.has("ArrowUp") ? 1 : 0) -
      (pressed.has("KeyS") || pressed.has("ArrowDown") ? 1 : 0);
    const strafe =
      (pressed.has("KeyD") || pressed.has("ArrowRight") ? 1 : 0) -
      (pressed.has("KeyA") || pressed.has("ArrowLeft") ? 1 : 0);
    const speed = pressed.has("ShiftLeft") || pressed.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;

    // 竖直方向永远交给物理（重力/落地/台阶），我们只覆盖水平两轴
    const linvel = body.linvel();
    let vertical = linvel.y;

    if (jumpQueued.current) {
      const position = body.translation();
      const ray = new rapier.Ray(
        { x: position.x, y: position.y, z: position.z },
        { x: 0, y: -1, z: 0 },
      );
      const grounded = Boolean(
        world.castRay(ray, GROUND_PROBE_DISTANCE, true, undefined, undefined, undefined, body),
      );
      if (grounded) vertical = JUMP_VELOCITY;
      jumpQueued.current = false;
    }

    if (!locked || (forward === 0 && strafe === 0)) {
      body.setLinvel({ x: 0, y: vertical, z: 0 }, true);
      return;
    }

    // 视线方向决定移动方向（先水平化，免得"抬头就往前上方飞"）
    camera.getWorldDirection(_direction);
    _direction.y = 0;
    if (_direction.lengthSq() < 1e-6) {
      body.setLinvel({ x: 0, y: vertical, z: 0 }, true);
      return;
    }
    _direction.normalize();
    const yaw = Math.atan2(-_direction.x, -_direction.z);
    const [x, z] = horizontalVelocity(forward, strafe, yaw, speed);
    body.setLinvel({ x, y: vertical, z }, true);
  });

  useAfterPhysicsStep(() => {
    const body = bodyRef.current;
    if (!body) return;
    const position = body.translation();
    camera.position.set(position.x, position.y + CHARACTER_EYE_OFFSET, position.z);
  });

  return (
    <>
      <RigidBody
        ref={bodyRef}
        type="dynamic"
        colliders={false}
        position={spawn}
        enabledRotations={[false, false, false]}
        linearDamping={0}
        // 抓取射线按这个标记排除角色自己（见 useObjectGrab）
        userData={{ character: true }}
        /*
          角色**不许睡**：睡着之后物理层不再 invalidate（`forEachActiveRigidBody`），
          站在原地看着某个方向时画面就不再重画；而且睡着的角色不会被重力处理，
          走到台阶边缘也不会掉下去。
        */
        canSleep={false}
      >
        <CapsuleCollider args={[capsule.halfSegment, capsule.radius]} />
      </RigidBody>
      <PointerLockControls
        ref={controlsRef}
        makeDefault
        selector={lockSelector}
        onUnlock={() => keys.current.clear()}
        /*
          显式要一帧：画布是 `frameloop="demand"`，而"转头"不改变任何刚体状态，
          没有别的东西会把这一帧排上（物理层只在有活动刚体时自己 invalidate）。
          只在真的转了视角时触发，不是每帧无条件 invalidate。
        */
        onChange={() => invalidate()}
      />
    </>
  );
}
