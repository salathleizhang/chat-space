import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import { dampToward, hasArrived, FLIGHT_DAMP_LAMBDA } from "../../shared/lib/cameraFlight";
import type { InspectionRequest } from "../../shared/lib/inspection";
import {
  composeInspectionSheet,
  SHEET_TILE,
  sheetToBase64,
} from "../../shared/lib/inspectionSheet";
import { captureQueue } from "../../shared/rendering/CaptureQueue";
import { captureScene } from "../../shared/rendering/capture";
import { useCaptureResult } from "../../shared/rendering/useCaptureResult";
import { webgpuRenderer } from "../../shared/rendering/webgpu";
import type { FocusPose } from "./focusPose";
import type { PaneControls } from "./paneControls";

/**
 * agent 的**贴近检查**：相机真的飞到模型旁边，到位后从这台相机的机位拍一张，再飞回出发前的机位。
 *
 * 为什么必须"真的过去"，而不是再开一台北窗外的专用相机：检查的题目是"这个模型摆在场景里
 * 合不合适"——贴着谁、有没有悬空/穿模、周围留了多大空。这要靠**它在场景里的实际样子**，
 * 而不是把它单独拎出来的四视角（那是 `target="asset"`，走预览小窗）。相机真的飞过去还有个
 * 连带好处：用户看得见 agent 在看哪儿；飞回原机位则是不留下被抢走的视角。
 *
 * 机位口径与**双击模型列表**逐项一致（摆放位置 + 固定偏移 [3,2,3]、同一段缓动、同一个
 * 到达阈值），所以"agent 看到的"就是"你双击看到的"，两边不会各有一套构图。
 *
 * 四条硬约束（每一条都对应一种踩过的症状）：
 *  ① `frameloop="demand"`：每一帧都要 `invalidate()`，否则相机停在半路，判定永远不"到达"；
 *  ② 画布隐藏时 `useFrame` 完全不走 ⇒ 超时只能用 `setTimeout`，且隐藏期间不算超时
 *     （与 `SceneInspectionCapturer` 同款）；
 *  ③ 到位后要先等模型**真的渲染出来**（包围盒非空）再按快门，否则拍到的是一帧空场景，
 *     agent 会据此汇报"场景里没有这个模型"；
 *  ④ 失败/中途取消都要把相机放回出发机位、把编辑器物件恢复可见——一次失败不该永久改变视角。
 */

/** 与主视口透视窗格同源的 fov（`ORBIT_CAMERA.fov`）。 */
const CLOSEUP_FOV = 45;
/** 与整场景检查同一个预算：发起后 10 s 还没拍到就如实报失败，别让 agent 干等。 */
const CLOSEUP_TIMEOUT_MS = 10_000;
/** 页面在后台时最多把超时往后顺延几次（每次 10 s），顺延期间不计超时。 */
const MAX_HIDDEN_EXTENSIONS = 5;
/** 到位后再跑几帧才按快门：飞行最后一帧与截图那一帧之间不要夹着未提交的状态。 */
const SETTLE_FRAMES = 2;
/** 后台切回来时 delta 可能是几十秒：钳住，免得"一步到位"（用户看不到飞行，判定也跳帧）。 */
const MAX_STEP_SECONDS = 0.1;
const CLOSEUP_LABEL = "CLOSE-UP";

/** 编辑器自己画的东西在贴近检查里是干扰项（400×400 的地面网格）。 */
const EDITOR_PREFIX = "editor:";
/** 但天空是**环境**不是干扰项：留着，否则特写的背景变成一块死黑。 */
const KEEP_EDITOR_PREFIX = "editor:sky";

type Phase = "fly" | "hold" | "capture" | "return" | "done";

interface Job {
  phase: Phase;
  /** 起飞时就定死这一趟的机位：中途改摆放不该让飞行改瞄（它是"这次检查"的快照）。 */
  pose: FocusPose | null;
  /** 出发前的机位，拍完要回到这里 */
  returnPose: FocusPose | null;
  png: string | null;
  /** 已进入 `hold` 之后跑过的帧数 */
  frames: number;
  /** 已经飞回出发机位（清理时据此决定要不要摆回去） */
  returned: boolean;
  settled: boolean;
  /** 截图期间被隐藏的编辑器物件，兜底恢复用 */
  hidden: THREE.Object3D[];
}

interface Rig {
  job: Job;
  capture: () => Promise<void>;
  /** 模型真的渲染出来了没有（包围盒非空） */
  modelReady: () => boolean;
  finish: (png: string | null) => void;
}

function readPose(camera: THREE.Camera, controls: PaneControls): FocusPose {
  return {
    camPos: [camera.position.x, camera.position.y, camera.position.z],
    lookAt: [controls.target.x, controls.target.y, controls.target.z],
  };
}

function writePose(controls: PaneControls, pose: FocusPose): void {
  controls.object.position.set(pose.camPos[0], pose.camPos[1], pose.camPos[2]);
  controls.target.set(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
  controls.update();
}

/** 朝目标姿态走一帧。位置与注视点用同一条 λ，所以两者同时收敛。 */
function stepCamera(
  camera: THREE.Camera,
  controls: PaneControls,
  pose: FocusPose,
  delta: number,
): void {
  const step = Math.min(delta, MAX_STEP_SECONDS);
  camera.position.x = dampToward(camera.position.x, pose.camPos[0], FLIGHT_DAMP_LAMBDA, step);
  camera.position.y = dampToward(camera.position.y, pose.camPos[1], FLIGHT_DAMP_LAMBDA, step);
  camera.position.z = dampToward(camera.position.z, pose.camPos[2], FLIGHT_DAMP_LAMBDA, step);
  controls.target.x = dampToward(controls.target.x, pose.lookAt[0], FLIGHT_DAMP_LAMBDA, step);
  controls.target.y = dampToward(controls.target.y, pose.lookAt[1], FLIGHT_DAMP_LAMBDA, step);
  controls.target.z = dampToward(controls.target.z, pose.lookAt[2], FLIGHT_DAMP_LAMBDA, step);
  controls.update();
}

/** 位置与注视点都到位才算到：只有位置到了、看着别处，拍出来的构图不是我们要的那一帧。 */
function arrivedAt(camera: THREE.Camera, controls: PaneControls, pose: FocusPose): boolean {
  return (
    hasArrived(
      camera.position.x - pose.camPos[0],
      camera.position.y - pose.camPos[1],
      camera.position.z - pose.camPos[2],
    ) &&
    hasArrived(
      controls.target.x - pose.lookAt[0],
      controls.target.y - pose.lookAt[1],
      controls.target.z - pose.lookAt[2],
    )
  );
}

function hideEditorObjects(scene: THREE.Object3D): THREE.Object3D[] {
  const hidden: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (!object.visible || !object.name.startsWith(EDITOR_PREFIX)) return;
    if (object.name.startsWith(KEEP_EDITOR_PREFIX)) return;
    object.visible = false;
    hidden.push(object);
  });
  return hidden;
}

function showObjects(hidden: readonly THREE.Object3D[]): void {
  for (const object of hidden) object.visible = true;
}

export function CloseupInspectionRig({
  request,
  poseRef,
  objects,
  assetId,
  controlsRef,
  onCaptured,
}: {
  /** 只认 `target="closeup"` 的请求；其他请求传 null（同一个 id 只结算一次，见 useCaptureResult） */
  request: InspectionRequest | null;
  /** 目标机位（由调用方按摆放位置 + 固定偏移算好）。这一刻还没有就等，别用错机位起飞。 */
  poseRef: RefObject<FocusPose | null>;
  /** 摆放模型的注册表（`index.tsx` 的 `objects`）：用来判断模型到底渲染出来没有 */
  objects: Map<string, THREE.Object3D>;
  /** 被检查资产的稳定 id（不是 slug） */
  assetId: string | null;
  /** 透视窗格的控制器：飞行的写入点与出发机位的读取点 */
  controlsRef: RefObject<PaneControls | null>;
  onCaptured: (id: string, pngBase64: string | null) => void;
}) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);
  const settle = useCaptureResult(request?.id ?? "none", onCaptured);
  const rigRef = useRef<Rig | null>(null);

  useEffect(() => {
    if (!request || request.target !== "closeup") return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, webgpuRenderer(gl).lifetime.signal]);
    const job: Job = {
      phase: "fly",
      pose: null,
      returnPose: null,
      png: null,
      frames: 0,
      returned: false,
      settled: false,
      hidden: [],
    };

    const finish = (png: string | null) => {
      if (job.settled) return;
      job.settled = true;
      invalidate();
      settle(request.id, png);
    };

    // 超时按**墙面时钟**而不是帧数：画布隐藏时一帧都不会来（见文件头 ②）。
    // 已经有图就先交图——"飞回原机位没走完"不该把一张拍到的好图作废。
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hiddenExtensions = 0;
    const armWatchdog = () => {
      timer = setTimeout(() => {
        if (job.settled) return;
        if (document.hidden && hiddenExtensions < MAX_HIDDEN_EXTENSIONS) {
          hiddenExtensions += 1;
          // 后台标签页里 rAF 会停：先排一帧，回到前台就能接着飞（否则永远醒不过来）
          invalidate();
          armWatchdog();
          return;
        }
        finish(job.png);
      }, CLOSEUP_TIMEOUT_MS);
    };
    armWatchdog();

    const capture = async () => {
      job.phase = "capture";
      const pose = job.pose;
      if (!pose) {
        job.phase = "return";
        invalidate();
        return;
      }
      try {
        const images = await captureQueue.enqueue("inspection", signal, async () => {
          // 隐藏只在真正渲染那一趟里发生（队列可能排队），外面照旧画网格。
          job.hidden = hideEditorObjects(scene);
          try {
            /*
              专用相机只借"飞行到的那个姿态"：位置/朝向/fov 与用户眼前那一帧相同，
              但用 1:1 的画幅（窗格是宽幅），避免把宽幅构图压进方图里。
              它也**始终是透视**——窗格被切成正交时（正交的可见高度是产品常量 15 世界单位，
              贴脸看会"看得极远"），用户眼前是正交视图，而检查图仍是这张说得清细节的特写。
            */
            const camera = new THREE.PerspectiveCamera(CLOSEUP_FOV, 1, 0.001, 1e6);
            camera.position.set(pose.camPos[0], pose.camPos[1], pose.camPos[2]);
            camera.up.set(0, 1, 0);
            camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
            const image = await captureScene(webgpuRenderer(gl), scene, camera, SHEET_TILE);
            return [image];
          } finally {
            showObjects(job.hidden);
            job.hidden = [];
          }
        });
        if (job.settled) return;
        job.png = sheetToBase64(
          composeInspectionSheet(images.map((image) => ({ image, label: CLOSEUP_LABEL }))),
        );
      } catch {
        // 任何一步失败都交给 finish 报失败：上层据此回传"截图失败"，而不是让 agent 干等。
        job.png = null;
      }
      if (job.settled) return;
      job.phase = "return";
      invalidate();
    };

    const modelReady = (): boolean => {
      if (!assetId) return false;
      const object = objects.get(assetId);
      if (!object) return false;
      const box = new THREE.Box3().setFromObject(object);
      return !box.isEmpty() && Number.isFinite(box.min.x);
    };

    rigRef.current = { job, capture, modelReady, finish };

    return () => {
      controller.abort();
      clearTimeout(timer);
      rigRef.current = null;
      // 还没走完就被取消（换请求、切会话、组件卸载）：把相机摆回出发机位、恢复编辑器物件，
      // 否则"一次失败的检查"会永久把用户的视角留在模型旁边。
      const controls = controlsRef.current;
      if (controls && job.returnPose && !job.returned) writePose(controls, job.returnPose);
      showObjects(job.hidden);
      job.hidden = [];
      invalidate();
    };
  }, [request, assetId, objects, controlsRef, poseRef, settle, gl, scene, invalidate]);

  useFrame((state, delta) => {
    const rig = rigRef.current;
    if (!rig) return;
    const job = rig.job;
    if (job.settled) return;
    const controls = controlsRef.current;
    if (!controls) {
      // 透视窗格还没挂上（切换投影、切布局、第一人称）：等它，别当作失败。
      state.invalidate();
      return;
    }
    const camera = controls.object;

    if (job.phase === "fly") {
      const pose = job.pose ?? poseRef.current;
      if (!pose) {
        state.invalidate();
        return;
      }
      job.pose = pose;
      if (!job.returnPose) job.returnPose = readPose(camera, controls);
      stepCamera(camera, controls, pose, delta);
      if (arrivedAt(camera, controls, pose)) {
        job.phase = "hold";
        job.frames = 0;
      }
      state.invalidate();
      return;
    }

    if (job.phase === "hold") {
      job.frames += 1;
      if (job.frames < SETTLE_FRAMES || !rig.modelReady()) {
        state.invalidate();
        return;
      }
      void rig.capture();
      return;
    }

    if (job.phase === "return") {
      if (!job.returnPose) {
        job.returned = true;
        job.phase = "done";
        rig.finish(job.png);
        return;
      }
      stepCamera(camera, controls, job.returnPose, delta);
      if (arrivedAt(camera, controls, job.returnPose)) {
        job.returned = true;
        job.phase = "done";
        rig.finish(job.png);
      } else {
        state.invalidate();
      }
    }
  });

  return null;
}
