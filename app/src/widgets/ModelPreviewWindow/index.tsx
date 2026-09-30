import { XIcon } from "@phosphor-icons/react/X";
import { Bounds } from "@react-three/drei/core/Bounds";
import { GizmoHelper, useGizmoContext } from "@react-three/drei/core/GizmoHelper";
import { OrbitControls } from "@react-three/drei/core/OrbitControls";
import { useThree } from "@react-three/fiber";
import { WebGPUCanvas } from "../../shared/rendering/WebGPUCanvas";
import { webgpuRenderer } from "../../shared/rendering/webgpu";
import { captureScene } from "../../shared/rendering/capture";
import type { InspectionRequest } from "../../shared/lib/inspection";
import { captureQueue } from "../../shared/rendering/CaptureQueue";
import { useCaptureResult } from "../../shared/rendering/useCaptureResult";
import { memo, Suspense, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import * as THREE from "three";
import type { AssetMaterial, AssetTransform, LibraryAsset } from "../../shared/lib/libraryApi";
import { Badge, Button, Panel } from "../../shared/ui";
import { ModelMesh } from "../Viewport/ModelMesh";
import { CameraAxes } from "../Viewport/PaneCamera";
import { createInspectionCamera } from "./inspectionViews";
import {
  composeInspectionSheet,
  resolveInspectionViews,
  sheetToBase64,
  SHEET_TILE,
} from "../../shared/lib/inspectionSheet";

/**
 * 模型预览小窗：模型栏双击打开，独立轨道相机 + 右上角视角球（Blender 式）。
 * 同时是视觉自检回路的执行者——收到 inspection 请求时自动从四个视角截图，
 * 合成 2×2 检查图（带视角标注）回调给上层上传并回传 agent。
 */

// 定义已搬到纯模块 `shared/lib/inspection.ts`（上层只取类型时不该依赖整个渲染组件）。
// 这里再导出一次，避免迁移期既有引用断掉。
export type { InspectionRequest } from "../../shared/lib/inspection";

interface ModelPreviewWindowProps {
  asset: LibraryAsset;
  /** 与主视口一致的旋转/缩放；位置由预览窗自动居中。 */
  transform?: AssetTransform;
  /** 与主视口一致的材质覆盖；不传即渲染供应商原材质 */
  material?: AssetMaterial;
  inspection: InspectionRequest | null;
  onClose: () => void;
  /** 四视角合成图完成（pngBase64 不含 data: 前缀）；失败时 base64 为 null */
  onInspectionCaptured: (id: string, pngBase64: string | null) => void;
}

const INSPECTION_POLL_MS = 120;
const INSPECTION_TIMEOUT_MS = 10_000;

function PreviewAxes() {
  const { tweenCamera } = useGizmoContext();
  return <group scale={40}><CameraAxes onSnap={tweenCamera} /></group>;
}

/** 在 Canvas 内执行四视角截图：等模型进场后，用独立相机拍摄。 */
function InspectionCapturer({
  request,
  onCaptured,
}: {
  request: InspectionRequest | null;
  onCaptured: (id: string, pngBase64: string | null) => void;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, webgpuRenderer(gl).lifetime.signal]);
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
        onCaptured(request.id, null);
        return;
      }
      const box = new THREE.Box3().setFromObject(scene);
      if (box.isEmpty() || !Number.isFinite(box.min.x)) {
        // 模型还没进场景（Suspense 加载中）：轮询等待，10s 放弃
        waited += INSPECTION_POLL_MS;
        if (waited > INSPECTION_TIMEOUT_MS) onCaptured(request.id, null);
        else timer = setTimeout(capture, INSPECTION_POLL_MS);
        return;
      }

      const sphere = box.getBoundingSphere(new THREE.Sphere());
      // 视角由请求指定（默认四视角；用户点名只看某个面时就只拍那一格）。
      // 截图相机独立于用户相机。ISO 用透视；轴向视角与主视口一样用正交投影。
      const views = resolveInspectionViews(request.views);

      try {
        // Submit all views in this JS task, before yielding to animation or
        // user edits. Readbacks remain asynchronous, but the pose is identical.
        const images = await captureQueue.enqueue("inspection", signal, () => Promise.all(views.map((view) => {
          const inspectionCamera = createInspectionCamera(
            camera as THREE.PerspectiveCamera,
            view,
            sphere.center,
            sphere.radius,
          );
          return captureScene(webgpuRenderer(gl), scene, inspectionCamera, SHEET_TILE);
        })));
        if (cancelled) return;
        // 版式在纯模块里，与 PlayCanvas 侧共用同一份（见 shared/lib/inspectionSheet.ts）。
        // 标注必须显式传：默认标签按四视角的**位置**取，只拍一格时那一格的语义会不对。
        const sheet = composeInspectionSheet(
          images.map((image: HTMLCanvasElement, index: number) => ({ image, label: views[index]!.label })),
        );
        // 让下一帧重新绘制用户的预览视角。
        invalidate();
        onCaptured(request.id, sheetToBase64(sheet));
      } catch {
        // 任何一步失败都回调 null：上层据此回传"截图失败"，而不是让 agent 干等。
        if (!cancelled) onCaptured(request.id, null);
        return;
      }
    };

    timer = setTimeout(capture, 0);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [request, gl, scene, camera, invalidate, onCaptured]);

  return null;
}

export const ModelPreviewWindow = memo(function ModelPreviewWindow({
  asset,
  transform,
  material,
  inspection,
  onClose,
  onInspectionCaptured,
}: ModelPreviewWindowProps) {
  const hasModel = asset.modelPath != null;
  const captured = useCaptureResult(`${asset.id}|${asset.resourceRevision ?? 0}|${inspection?.id ?? "none"}`, onInspectionCaptured);

  /** 拖动窗口只改外壳的 DOM transform，不把 pointermove 写进 React state：否则每次
      移动都会连带协调下方整棵 R3F Canvas 子树。偏移留在 ref，松手后下一次拖动仍能
      从当前位置继续；这是运行时定位坐标，不受业务层禁止内联 style 的约束。 */
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{
    host: HTMLElement;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const host = event.currentTarget.parentElement;
    if (!host) return;
    dragRef.current = {
      host,
      startX: event.clientX,
      startY: event.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const x = drag.originX + (event.clientX - drag.startX);
    const y = drag.originY + (event.clientY - drag.startY);
    offsetRef.current.x = x;
    offsetRef.current.y = y;
    drag.host.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const handleDragPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <Panel className="flex w-[22rem] flex-col overflow-hidden">
      <div
        className="relative flex h-11 shrink-0 cursor-grab items-center justify-center px-3 select-none active:cursor-grabbing"
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={handleDragPointerUp}
      >
        {/* 按钮/徽标离全局 surface 圆角(35px)要留够距离,否则方形边角会被 overflow-hidden
            按弧线削掉——固定 top-3 而不是垂直居中,这样 header 矮下去也不会把插槽推回圆角范围。 */}
        {inspection && (
          <div className="pointer-events-none absolute top-3 left-3.5">
            <Badge>Agent inspecting…</Badge>
          </div>
        )}
        <span className="pointer-events-none max-w-[65%] truncate text-sm font-medium text-ink-strong">
          {asset.name}
        </span>
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={XIcon}
          aria-label="Close preview"
          onClick={onClose}
          disabled={inspection != null}
          className="absolute top-3 right-3.5"
        />
      </div>
      <div className="aspect-square w-full">
        {hasModel ? (
          <WebGPUCanvas
            key={asset.modelPath}
            frameloop="demand"
            dpr={[1, 1.5]}
            camera={{ position: [1.6, 1.2, 1.6], fov: 45 }}
            onFailure={() => { if (inspection) captured(inspection.id, null); }}
          >
            <ambientLight intensity={0.7} />
            <directionalLight position={[4, 6, 4]} intensity={1.4} />
            <directionalLight position={[-4, 2, -3]} intensity={0.5} />
            <Suspense fallback={null}>
              <Bounds fit clip observe margin={1.3}>
                <group rotation={transform?.rotation} scale={transform?.scale}>
                  <ModelMesh asset={asset} material={material} />
                </group>
              </Bounds>
            </Suspense>
            <OrbitControls makeDefault enableDamping />
            <GizmoHelper alignment="top-right" margin={[52, 52]}>
              <PreviewAxes />
            </GizmoHelper>
            <InspectionCapturer
              request={inspection}
              onCaptured={captured}
            />
          </WebGPUCanvas>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-ink-subtle">
            This asset has no renderable model output
          </div>
        )}
      </div>
    </Panel>
  );
});
