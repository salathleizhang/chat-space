import { useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect } from "react";
import * as THREE from "three";
import { GRAB_MAX_DISTANCE } from "./physics";
import { boundsReportStats, installPhysicsDebug, type PhysicsDebugBody } from "./physicsDebug";

const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/**
 * 把"引擎事实"接到诊断口上（见 physicsDebug.ts 的说明）。读的是 rapier 自己的
 * `rigidBodyStates`，不是我们自己的记账——"我传了参数"不等于"刚体真的在那里"。
 */
export function PhysicsDebugBridge({ enabled }: { enabled: boolean }) {
  const { rapier, world, rigidBodyStates } = useRapier();
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    if (!enabled) return;

    const collect = (): PhysicsDebugBody[] =>
      [...rigidBodyStates.values()].map((state) => {
        const translation = state.rigidBody.translation();
        const character =
          (state.rigidBody.userData as { character?: boolean } | null)?.character === true;
        return {
          handle: state.rigidBody.handle,
          name: state.object.name || null,
          position: [translation.x, translation.y, translation.z],
          awake: !state.rigidBody.isSleeping(),
          type: state.rigidBody.bodyType(),
          character,
          /*
            `numColliders` 与 `mass` 是"碰撞体到底建了没有"的引擎事实：
            没有碰撞体的刚体质量是 0，而且会直接穿透一切——只看我们自己的记账
            （"我给 PhysicalAsset 传了 bounds"）会把这种情况读成"已经挂上了"。
          */
          colliders: state.rigidBody.numColliders(),
          mass: state.rigidBody.mass(),
        };
      });

    return installPhysicsDebug({
      camera: () => ({
        position: camera.position.toArray() as [number, number, number],
        quaternion: camera.quaternion.toArray() as [number, number, number, number],
      }),
      bodies: collect,
      character: () => collect().find((body) => body.character) ?? null,
      teleport: (handle, position) => {
        const state = rigidBodyStates.get(handle);
        if (!state) return false;
        state.rigidBody.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
        state.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        state.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        state.rigidBody.wakeUp();
        return true;
      },
      // 只改朝向：位置由物理角色每步写回，这里写位置会和它打架
      look: (yaw, pitch) => {
        camera.quaternion.setFromEuler(_euler.set(pitch, yaw, 0));
      },
      awake: () => {
        let count = 0;
        world.forEachActiveRigidBody(() => {
          count += 1;
        });
        return count;
      },
      world: () => ({
        bodies: rigidBodyStates.size,
        colliders: world.colliders.len(),
      }),
      boundsReports: () => boundsReportStats(),
      /*
        判据与 `useObjectGrab.tryGrab` **逐字一致**（同样的距离上限、同样的过滤谓词）：
        这样"射线打没打中"与"关节建没建起来"才是两个可分辨的结论。
      */
      raycast: () => {
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction).normalize();
        const hit = world.castRay(
          new rapier.Ray(
            { x: camera.position.x, y: camera.position.y, z: camera.position.z },
            { x: direction.x, y: direction.y, z: direction.z },
          ),
          GRAB_MAX_DISTANCE,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          (collider) => {
            const body = collider.parent();
            return Boolean(
              body
              && body.isDynamic()
              && (body.userData as { character?: boolean } | null)?.character !== true,
            );
          },
        );
        if (!hit) return { hit: false, from: camera.position.toArray(), direction: direction.toArray() };
        const body = hit.collider.parent();
        const state = body
          ? [...rigidBodyStates.values()].find((entry) => entry.rigidBody.handle === body.handle)
          : null;
        return {
          hit: true,
          toi: hit.timeOfImpact,
          bodyName: state?.object.name ?? null,
          dynamic: body?.isDynamic() ?? null,
        };
      },
      colliderFacts: (handle) => {
        const state = rigidBodyStates.get(handle);
        if (!state) return null;
        const colliders = [];
        state.rigidBody.numColliders();
        for (let i = 0; i < state.rigidBody.numColliders(); i += 1) {
          const collider = state.rigidBody.collider(i);
          const shape = collider.shape as { type?: number; halfExtents?: { x: number; y: number; z: number } };
          const translation = collider.translation();
          colliders.push({
            shapeType: shape.type ?? null,
            halfExtents: shape.halfExtents ? [shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z] : null,
            worldTranslation: [translation.x, translation.y, translation.z],
            isSensor: collider.isSensor(),
            collisionGroups: collider.collisionGroups(),
            parentHandle: collider.parent()?.handle ?? null,
            enabled: collider.isEnabled?.() ?? null,
          });
        }
        return colliders;
      },
    });
  }, [camera, enabled, rigidBodyStates, world]);

  return null;
}
