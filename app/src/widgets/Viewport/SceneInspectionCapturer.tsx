import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import * as THREE from "three";
import { captureQueue } from "../../shared/rendering/CaptureQueue";
import { captureScene } from "../../shared/rendering/capture";
import { useCaptureResult } from "../../shared/rendering/useCaptureResult";
import { webgpuRenderer } from "../../shared/rendering/webgpu";
import type { InspectionRequest } from "../../shared/lib/inspection";
import {
  composeInspectionSheet,
  DEFAULT_SCENE_VIEW,
  INSPECTION_VIEW_LIBRARY,
  SHEET_TILE,
  sheetToBase64,
} from "../../shared/lib/inspectionSheet";
import { createInspectionCamera } from "../ModelPreviewWindow/inspectionViews";

/**
 * 整场景检查的执行者：收到请求时按**一个机位**拍整个场景。
 *
 * 与预览小窗那份四视角截图器的差别只有取景和机位两处：
 *  ① 取景对象是**场景里的内容**（摆放模型的 `asset:` 组；没有摆放模型时退回 world 组），
 *     不是整棵场景树——天空背景球（半径 200、跟着相机走）与 400×400 的编辑器网格会把
 *     `Box3` 撑到世界尺度，照它们取景等于把整个场景拍成一个点；
 *  ② 只拍一个机位。拍出来能不能用由 agent 看图判断——不合适它就用同一个工具换一个
 *     机位（iso/前/右/顶/左/后/底）再看，直到能看清为止。
 */

/** 场景内容的分组名：摆放模型（见 index.tsx 的 PlacedAsset）与 world 内容。 */
const PLACED_ASSET_PREFIX = "asset:";
const WORLD_GROUP_NAME = "scene:world";
/** 编辑器自己画的东西（网格、天空背景），永远不参与取景。 */
const EDITOR_PREFIX = "editor:";

const INSPECTION_POLL_MS = 120;
const INSPECTION_TIMEOUT_MS = 10_000;
/** 检查相机独立于窗格相机，只借它的 fov 决定取景距离。 */
const SCENE_CAMERA_FOV = 45;
const SOURCE_ASPECT = 1;

/**
 * 取景包围盒：优先摆放的模型，其次 world 内容，最后退回顶层非编辑器对象。
 *
 * 逐层退回是为了让"只有 world 的项目"也能检查；`editor:` 前缀的网格与天空球
 * 在任何一层都不参与——天空球半径 200 且跟着相机走，网格是 400×400 的平面，
 * 任何一个进了包围盒都会把场景拍成一个点。
 */
function sceneContentBox(scene: THREE.Object3D): THREE.Box3 {
  const content = new THREE.Box3();
  const world = new THREE.Box3();
  scene.traverse((object) => {
    if (object.name.startsWith(PLACED_ASSET_PREFIX)) content.expandByObject(object);
    else if (object.name === WORLD_GROUP_NAME) world.expandByObject(object);
  });
  if (!content.isEmpty()) return content;
  if (!world.isEmpty()) return world;
  const rest = new THREE.Box3();
  for (const child of scene.children) {
    if (child.name.startsWith(EDITOR_PREFIX)) continue;
    rest.expandByObject(child);
  }
  return rest;
}

export function SceneInspectionCapturer({
  request,
  onCaptured,
}: {
  request: InspectionRequest | null;
  onCaptured: (id: string, pngBase64: string | null) => void;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  // 一次请求只结算一次：StrictMode 双挂载、设备丢失与读回失败会同时到达。
  const settle = useCaptureResult(request?.id ?? "none", onCaptured);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, webgpuRenderer(gl).lifetime.signal]);
    const view = INSPECTION_VIEW_LIBRARY[request.views?.[0] ?? DEFAULT_SCENE_VIEW];
    let waited = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const capture = async () => {
      if (cancelled) return;
      // 后台标签页的 ResizeObserver/rAF/绘制都会冻结。隐藏期间泊住且不计超时，回到
      // 前台后继续；setTimeout 只会被节流，不会像 rAF 一样完全失去唤醒机会。
      if (document.hidden) {
        timer = setTimeout(capture, INSPECTION_POLL_MS);
        return;
      }
      if (webgpuRenderer(gl).lost) {
        settle(request.id, null);
        return;
      }
      const box = sceneContentBox(scene);
      if (box.isEmpty() || !Number.isFinite(box.min.x)) {
        // 场景内容还没进场（Suspense 加载中）：轮询等待，10s 放弃
        waited += INSPECTION_POLL_MS;
        if (waited > INSPECTION_TIMEOUT_MS) settle(request.id, null);
        else timer = setTimeout(capture, INSPECTION_POLL_MS);
        return;
      }

      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const source = new THREE.PerspectiveCamera(SCENE_CAMERA_FOV, SOURCE_ASPECT, 0.001, 1e6);
      try {
        const images = await captureQueue.enqueue("inspection", signal, () =>
          captureScene(
            webgpuRenderer(gl),
            scene,
            createInspectionCamera(source, view, sphere.center, sphere.radius),
            SHEET_TILE,
          ).then((image) => [image]),
        );
        if (cancelled) return;
        // 单格也要显式给标签：默认标签按四视角的**位置**取，只拍 "top" 时会标成 ISO。
        const sheet = composeInspectionSheet(
          images.map((image: HTMLCanvasElement) => ({ image, label: view.label })),
        );
        // 让下一帧重新绘制窗格（截图期间渲染器被借走了一趟）。
        invalidate();
        settle(request.id, sheetToBase64(sheet));
      } catch {
        // 任何一步失败都回调 null：上层据此回传"截图失败"，而不是让 agent 干等。
        if (!cancelled) settle(request.id, null);
        return;
      }
    };

    timer = setTimeout(capture, 0);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [request, gl, scene, settle, invalidate]);

  return null;
}
