import { useThree } from "@react-three/fiber";
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier, type RapierRigidBody } from "@react-three/rapier";
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
import { grabbedAssetId } from "./grabSelection";
import type { BodyPose } from "./grabCommit";
import { settleHeld } from "../../shared/lib/settleHold";

const _origin = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _inverse = new THREE.Quaternion();
const _offset = new THREE.Vector3();

/**
 * 「松手之后算落定了」的两条判据：刚体睡着，或者速度已经小到看不出来。
 *
 * 为什么不能只看"松手那一瞬"：松手会把速度还给物体（`release` 的甩出），它还要飞一段、
 * 掉到地上、再滚一会儿。**松手那一刻的姿态根本不是它最后待的地方**，
 * 照那一刻落盘等于把"摆放"写成半空中的一个位置。
 *
 * 而且**"这一刻速度小"本身也不够**：把沙发端在半空、停下鼠标再松开时，关节会把它吊住
 * ⇒ 速度≈0。所以还要 `settleHeld` 的"连续静够 150 ms"（见 `shared/lib/settleHold.ts`）。
 */
const SETTLE_LINEAR_EPSILON = 0.05;
const SETTLE_ANGULAR_EPSILON = 0.15;
/**
 * 等落定的上限：投掷出去的物体可能滚很久（阻尼 0.45 下 5 m/s 衰减到 0.05 要 ~10 s）。
 * 到点就按**当时**的姿态落盘，不无限等——判据是"用户在等右侧栏的数字"，
 * 不是"物理必须停稳"。残余误差写在 PHYSICS.md 第 8 节。
 */
const SETTLE_TIMEOUT_MS = 5_000;

interface ActiveGrab {
  body: RapierRigidBody;
  /** 弹簧关节：锚点（kinematic）↔ 抓取点（物体上的那个点） */
  joint: ReturnType<ReturnType<typeof useRapier>["world"]["createImpulseJoint"]>;
  /** 抓取点到相机的距离；拖拽时锚点 = 相机 + 视线 × depth */
  depth: number;
  previous: [number, number, number];
  release: [number, number, number];
  /** 抓到的是哪件资产（解析不出来时为 null：那时既不选中、也不落盘） */
  assetId: string | null;
}

/** 松手后等待落定的一次落盘 */
interface PendingDrop {
  assetId: string;
  body: RapierRigidBody;
  /** 到点无条件落盘 */
  deadline: number;
  /** 连续静止的起点（见 `settleHold.ts`：只看"这一刻速度小"会把半空中的假静止当成落定） */
  stillSince: number | null;
}

/** 刚体姿态（rapier 的形状）→ 我们这边要的 `BodyPose` */
function bodyPose(body: RapierRigidBody): BodyPose {
  const t = body.translation();
  const r = body.rotation();
  return { position: [t.x, t.y, t.z], quaternion: [r.x, r.y, r.z, r.w] };
}

/** 刚体是不是停下来了。刚体可能已经被卸载（读它会抛），那种情况按"停下"处理 */
function isSettled(body: RapierRigidBody): boolean {
  try {
    if (body.isSleeping()) return true;
    const linear = body.linvel();
    const angular = body.angvel();
    return Math.hypot(linear.x, linear.y, linear.z) < SETTLE_LINEAR_EPSILON
      && Math.hypot(angular.x, angular.y, angular.z) < SETTLE_ANGULAR_EPSILON;
  } catch {
    return true;
  }
}

function isCharacter(body: RapierRigidBody | null): boolean {
  if (!body) return false;
  return (body.userData as { character?: boolean } | null)?.character === true;
}

/**
 * 第一人称下的**准星抓取**：点住左键把面前的物体"粘"在视线方向上，松手带速度甩出。
 *
 * 取物方式是**屏幕中心**的射线（指针锁定时鼠标本来就被钉在中心），而 three 侧的拾取代理
 * （`PanePickTarget`）在第一人称下**整棵都不挂**（没有窗格就没有 pick target），所以这里直接用
 * rapier 自己的 raycast——它查的是碰撞体，恰好就是"能不能抓到"的判据本身。
 *
 * 搬运方式**照抄 image-blaster 的 `useObjectGrab`**（原仓库 `gabo/image-blaster`）：
 * 球形关节（`JointData.spherical`）把**射线命中的那个表面点**挂在 kinematic 锚点上，
 * 锚点每步跟手；**每个物理步前后各钳一次线速/角速**（5 / 10）。摇摆与下坠来自
 * "抓取点被锁住、姿态自由"这件事本身——不是靠弹簧，所以没有橡皮筋式的手感。
 * 逐项对照与"为什么以前会抖"见 PHYSICS.md 第 9 节。
 *
 * 三条纪律：
 * 1. **射线排除角色自己**（`userData.character`），否则准星永远先命中自己的胶囊体；
 * 2. **只抓 dynamic 刚体**：世界地形是 fixed、`static` 物体也是 fixed，抓它们等于抓空气；
 * 3. **每步都钳速度**（线 5 / 角 10）：不钳的话"把物体拖进墙里"会让解算器给出爆炸速度，
 *    物体会以肉眼看不到的速度飞出场景（与 image-blaster 的 clampBodyVelocity 同参数）。
 *
 * 另外：**抓住的那一刻会回调 `onGrab(assetId)`**——第一人称里"拿一下模型"与第三人称里
 * "点中它"是同一件事，两边都该把它送进右侧栏（`grabSelection.ts` 解释了 id 从哪来、
 * 为什么解析不出来时必须什么都不做）。回调**不参与**抓取是否成立：射线命中、关节建起来
 * 才算抓住，选中只是抓住之后的副作用。
 *
 * **松手之后还会回调一次 `onDrop(assetId, pose)`，但不是在松手那一瞬**：甩出去的物体要飞一段、
 * 掉到地上、再滚一会儿。等它停下（睡着 / 速度小于阈值，5 s 封顶）才把姿态交出去落盘，
 * 这样的"摆放"才是它真正待着的地方。详情与残余误差见 `grabCommit.ts` 与 PHYSICS.md 第 8 节。
 */
export function useObjectGrab({
  enabled,
  onGrab,
  onDrop,
}: {
  enabled: boolean;
  /** 抓到资产时回调稳定 id（角色刚体/世界静态物不会触发） */
  onGrab?: (assetId: string) => void;
  /** 抓住的东西**落定**之后回调它的姿态（只有真的动过才由调用方决定要不要写回） */
  onDrop?: (assetId: string, pose: BodyPose) => void;
}) {
  const camera = useThree((state) => state.camera);
  const { rapier, world } = useRapier();
  const anchorRef = useRef<RapierRigidBody | null>(null);
  const activeRef = useRef<ActiveGrab | null>(null);
  const pendingRef = useRef<PendingDrop[]>([]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  /*
    回调走 ref：调用方（Viewport）每次渲染都可能给出新函数身份，而这个 hook 的下游
    （`tryGrab` 被 pointerdown 监听持有，落盘在物理步里）**不该因此重新订阅**——
    那是每帧摘挂一次全局监听。
  */
  const onGrabRef = useRef(onGrab);
  onGrabRef.current = onGrab;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  /** 把一次等待落定的读数交出去。刚体可能已经被卸载（换资产/切布局），读它会抛，忽略即可 */
  const flushDrop = useCallback((entry: PendingDrop) => {
    try {
      onDropRef.current?.(entry.assetId, bodyPose(entry.body));
    } catch {
      // 刚体已经不在了：这一件这次就不落盘
    }
  }, []);

  /**
   * 把抓着的物体的速度钳到 5 / 10 —— **image-blaster 的 `clampBodyVelocity`**，
   * 而且它是在**每个物理步前后各调一次**（`useBeforePhysicsStep` + `useAfterPhysicsStep`）。
   * 两次都要：步前管"这一帧要推多远"，步后管"接触解算器给出的回弹别过大"。
   * 只钳步前那一版在我们这里就是抖的（6.07 mm），照抄成两次之后是 0.97 mm。
   */
  const clampGrabBody = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    try {
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
    } catch {
      // 刚体可能已经被卸载（换资产、切布局）
    }
  }, []);

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
      // 拆掉关节（image-blaster 的 endGrab 第一句）
      world.removeImpulseJoint(active.joint, true);
    } catch {
      // 世界可能正在重建（资产换修订号、布局切换），陈旧关节忽略即可
    }
    try {
      // 甩出：把这最后一笔手的速度还给物体（与 image-blaster 的 releaseVelocity 同源）
      active.body.setLinvel({ x: active.release[0], y: active.release[1], z: active.release[2] }, true);
      clampGrabBody();
      active.body.wakeUp();
    } catch {
      // 刚体可能已经被卸载
    }
    /*
      记一笔"等它停下再落盘"。**不在这一刻落盘**：这一秒物体还带着甩出的速度在半空，
      它的位置马上就变了（见 SETTLE_* 的说明）。
    */
    if (active.assetId) {
      pendingRef.current.push({
        assetId: active.assetId,
        body: active.body,
        deadline: Date.now() + SETTLE_TIMEOUT_MS,
        stillSince: null,
      });
    }
  }, [clampGrabBody, world]);

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

    // image-blaster 的写法：下限 0.1，免得贴脸命中时目标点落在相机后面
    const depth = Math.max(hit.timeOfImpact, 0.1);
    const point = {
      x: _origin.x + _forward.x * depth,
      y: _origin.y + _forward.y * depth,
      z: _origin.z + _forward.z * depth,
    };

    /*
      **球形关节**，body 一侧的锚点写在**射线命中的那个表面点**上——与 image-blaster 的
      `beginGrab` 逐行同构：`anchor.setTranslation(worldPoint)` + `setNextKinematicTranslation`，
      然后 `JointData.spherical(_zeroVector, bodyAnchor)`，其中 bodyAnchor =
      `(worldPoint − bodyPosition) · bodyRotation⁻¹`。

      手感就来自这个"点锁住、姿态自由"：抓取点被你钉住（平移是刚性的、没有橡皮筋），
      物体绕它自由摆 ⇒ 一动手它会**晃**，重力让它**坠**。抓在刚体原点上会变成纯平移，
      一点摇摆都没有（试过，被否掉）。

      以前这里抖的原因**不是关节本身**，而是我们抄漏了 image-blaster 的另一半：
      它每个物理步**前后各钳一次速度**，而且物体刚体带 `additionalSolverIterations={4}`
      （见 `PhysicalAsset`）。补上之后同场景台架 y 峰峰从 6.07 mm 掉到 **0.97 mm**
      （1.8 m 处约 0.6 px，看不见）。详见 PHYSICS.md 第 9 节。
    */
    const translation = body.translation();
    const rotation = body.rotation();
    // 关节锚点写在**物体局部坐标系**里：世界点减去刚体位置再转进它的姿态
    _inverse.set(rotation.x, rotation.y, rotation.z, rotation.w).invert();
    _offset.set(point.x - translation.x, point.y - translation.y, point.z - translation.z);
    _offset.applyQuaternion(_inverse);

    const anchor = ensureAnchor();
    anchor.setTranslation(point, true);
    anchor.setNextKinematicTranslation(point);

    const joint = world.createImpulseJoint(
      rapier.JointData.spherical(
        { x: 0, y: 0, z: 0 },
        { x: _offset.x, y: _offset.y, z: _offset.z },
      ),
      anchor,
      body,
      true,
    );

    // 抓取瞬间先钳一次（image-blaster 的 beginGrab 里 clampBodyVelocity 排在 wakeUp 之前）
    activeRef.current = {
      body,
      joint,
      depth,
      // "手"的起点就是锚点（抓取点），甩出速度量的因此仍是手的位移
      previous: [point.x, point.y, point.z],
      release: [0, 0, 0],
      assetId: null,
    };
    clampGrabBody();
    body.wakeUp();
    /*
      解析资产 id 要在建状态**之前**做，因为下面那笔"取消上一轮的等待落定"要用它对照。
      解析不出 id 时**什么也不做**——第一人称里那一下点击的本意是"抓"，没抓到不等于"点空白"。
    */
    const assetId = grabbedAssetId(body.userData);
    /*
      又抓起了**同一个刚体**：上一轮那次落盘就作废（这次松手会重新等落定），
      否则它会在半空中被落一次盘、再被落第二次。别的刚体那几笔不受影响。
    */
    if (assetId) {
      pendingRef.current = pendingRef.current.filter((entry) => entry.body !== body);
    }
    activeRef.current.assetId = assetId;
    // 抓住之后才通知"选中它"（不是射线一命中就叫）：`activeRef` 已经落位，"抓住了"与"选中了"是同一个事件
    if (assetId) onGrabRef.current?.(assetId);
  }, [camera, clampGrabBody, ensureAnchor, rapier, world]);

  useBeforePhysicsStep((physicsWorld) => {
    /*
      先处理"等落定"的那几笔：它们与手上是否抓着东西无关（可以抓着 A 等 B 停下）。
      到点或停稳就交出去落盘，一次物理步处理一批。
    */
    const pending = pendingRef.current;
    if (pending.length > 0) {
      const now = Date.now();
      const settled: PendingDrop[] = [];
      const remaining: PendingDrop[] = [];
      for (const entry of pending) {
        if (now >= entry.deadline) {
          settled.push(entry);
          continue;
        }
        /*
          「静够 150 ms 才算落定」，不是"这一刻速度小"：把沙发端在半空、停下鼠标再松开时，
          关节会把它稳稳吊住 ⇒ 那一刻速度≈0，照"速度小"判就会在**半空**里记下摆放。
          重力一让它动，计时就清零（见 `settleHold.ts`）。
        */
        const held = settleHeld(entry.stillSince, isSettled(entry.body), now);
        entry.stillSince = held.stillSince;
        if (held.commit) settled.push(entry);
        else remaining.push(entry);
      }
      pendingRef.current = remaining;
      for (const entry of settled) flushDrop(entry);
    }

    const active = activeRef.current;
    if (!active) return;

    camera.getWorldPosition(_origin);
    camera.getWorldDirection(_forward).normalize();
    /*
      把**锚点**挪到"手的当前位置"：视线上的固定距离点。弹簧负责让物体跟上它——
      落后多少、垂下多少、停下后摆几回，全由弹簧的刚度/阻尼决定（常数见 `physics.ts`）。
    */
    const target: [number, number, number] = [
      _origin.x + _forward.x * active.depth,
      _origin.y + _forward.y * active.depth,
      _origin.z + _forward.z * active.depth,
    ];

    const timestep = physicsWorld.timestep || 1 / 60;
    active.release = dragVelocity(active.previous, target, timestep, GRAB_LINEAR_LIMIT);
    active.previous = target;
    anchorRef.current?.setNextKinematicTranslation({ x: target[0], y: target[1], z: target[2] });

    // 步前钳一次（image-blaster 的 `useBeforePhysicsStep` 末尾那一句）
    clampGrabBody();
  });

  // 步后再钳一次（它的 `useAfterPhysicsStep`）——少了这一半，接触回弹就会留在物体上
  useAfterPhysicsStep(() => {
    clampGrabBody();
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
      /*
        卸载（退出第一人称、切资产、卸载视口）时**立刻**把等待落定的几笔交出去：
        这一刻物理世界跟着暂停（`paused={!physicsRunning}`），物体就停在它当前的位置上，
        所以"读到什么就落什么"与画面一致。不这么做的话，那几笔等不到下一个物理步，
        抓起来挪过的位置就悄悄丢了。
        顺序不能反：**先 `release()`**（手上还抓着的那个也变成一笔），再一起交出去。
      */
      release();
      for (const entry of pendingRef.current) flushDrop(entry);
      pendingRef.current = [];
      const anchor = anchorRef.current;
      anchorRef.current = null;
      if (!anchor) return;
      try {
        world.removeRigidBody(anchor);
      } catch {
        // 世界已经销毁
      }
    };
  }, [flushDrop, release, world]);

  /** 交给调用方的不只是"能不能抓"，还有诊断口要用的同一批函数（见 physicsDebug.ts） */
  return { tryGrab, release, isGrabbing: () => activeRef.current !== null };
}
