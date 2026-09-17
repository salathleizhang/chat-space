import { XIcon } from "@phosphor-icons/react/X";
import { Bounds } from "@react-three/drei/core/Bounds";
import { GizmoHelper } from "@react-three/drei/core/GizmoHelper";
import { GizmoViewport } from "@react-three/drei/core/GizmoViewport";
import { OrbitControls } from "@react-three/drei/core/OrbitControls";
import { Canvas, useThree } from "@react-three/fiber";
import { memo, Suspense, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import * as THREE from "three";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import { Badge, Button, Panel } from "../../shared/ui";
import { ModelMesh } from "../Viewport/ModelMesh";

/**
 * 模型预览小窗：模型栏双击打开，独立轨道相机 + 右上角视角球（Blender 式）。
 * 同时是视觉自检回路的执行者——收到 inspection 请求时自动从四个视角截图，
 * 合成 2×2 检查图（带视角标注）回调给上层上传并回传 agent。
 */

export interface InspectionRequest {
  /** 截图批次 id（来自 agent 工具调用的 toolCallId） */
  id: string;
}

interface ModelPreviewWindowProps {
  asset: LibraryAsset;
  inspection: InspectionRequest | null;
  onClose: () => void;
  /** 四视角合成图完成（pngBase64 不含 data: 前缀）；失败时 base64 为 null */
  onInspectionCaptured: (id: string, pngBase64: string | null) => void;
}

/** 检查图四视角（与提示词中的说明一致：ISO/前/右/顶） */
const INSPECTION_VIEWS: { label: string; dir: [number, number, number] }[] = [
  { label: "ISO", dir: [1, 0.8, 1] },
  { label: "FRONT", dir: [0, 0.12, 1] },
  { label: "RIGHT", dir: [1, 0.12, 0] },
  { label: "TOP", dir: [0.001, 1, 0.001] },
];

const SHEET_TILE = 512;
const INSPECTION_POLL_MS = 120;
const INSPECTION_TIMEOUT_MS = 10_000;

/** 在 Canvas 内执行四视角截图：等模型出现在场景里再动手，完成后恢复相机 */
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
    let waited = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const capture = () => {
      if (cancelled) return;
      // 后台标签页的 ResizeObserver/rAF/绘制都会冻结。隐藏期间泊住且不计超时，回到
      // 前台后继续；setTimeout 只会被节流，不会像 rAF 一样完全失去唤醒机会。
      if (document.hidden) {
        timer = setTimeout(capture, INSPECTION_POLL_MS);
        return;
      }
      if (gl.getContext().isContextLost()) {
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
      const persp = camera as THREE.PerspectiveCamera;
      // 单点/极薄退化几何的包围球可能为 0；相机落到球心会让 lookAt 退化并截出空图。
      const radius = Math.max(sphere.radius, 1e-3);
      const fitDistance =
        (radius / Math.tan((persp.fov * Math.PI) / 360)) * 1.35;
      const savedPosition = camera.position.clone();
      const savedQuaternion = camera.quaternion.clone();

      const sheet = document.createElement("canvas");
      sheet.width = SHEET_TILE * 2;
      sheet.height = SHEET_TILE * 2;
      const ctx = sheet.getContext("2d");
      if (!ctx) {
        onCaptured(request.id, null);
        return;
      }

      INSPECTION_VIEWS.forEach((view, i) => {
        const dir = new THREE.Vector3(...view.dir).normalize();
        camera.position.copy(sphere.center).addScaledVector(dir, fitDistance);
        camera.lookAt(sphere.center);
        persp.updateProjectionMatrix();
        gl.render(scene, camera);

        const x = (i % 2) * SHEET_TILE;
        const y = Math.floor(i / 2) * SHEET_TILE;
        ctx.drawImage(gl.domElement, x, y, SHEET_TILE, SHEET_TILE);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = "bold 22px system-ui, sans-serif";
        ctx.fillText(view.label, x + 14, y + 32);
      });
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, sheet.width, sheet.height);
      ctx.beginPath();
      ctx.moveTo(SHEET_TILE, 0);
      ctx.lineTo(SHEET_TILE, sheet.height);
      ctx.moveTo(0, SHEET_TILE);
      ctx.lineTo(sheet.width, SHEET_TILE);
      ctx.stroke();

      // 恢复到截图前的相机姿态，留给用户继续手动查看
      camera.position.copy(savedPosition);
      camera.quaternion.copy(savedQuaternion);
      persp.updateProjectionMatrix();
      invalidate();

      const dataUrl = sheet.toDataURL("image/png");
      onCaptured(request.id, dataUrl.slice(dataUrl.indexOf(",") + 1));
    };

    timer = setTimeout(capture, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [request, gl, scene, camera, invalidate, onCaptured]);

  return null;
}

export const ModelPreviewWindow = memo(function ModelPreviewWindow({
  asset,
  inspection,
  onClose,
  onInspectionCaptured,
}: ModelPreviewWindowProps) {
  const hasModel = asset.modelPath != null;

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
          <Canvas
            key={asset.modelPath}
            frameloop="demand"
            dpr={[1, 1.5]}
            camera={{ position: [1.6, 1.2, 1.6], fov: 45 }}
            gl={{ preserveDrawingBuffer: true, alpha: true }}
          >
            <ambientLight intensity={0.7} />
            <directionalLight position={[4, 6, 4]} intensity={1.4} />
            <directionalLight position={[-4, 2, -3]} intensity={0.5} />
            <Suspense fallback={null}>
              <Bounds fit clip observe margin={1.3}>
                <ModelMesh asset={asset} />
              </Bounds>
            </Suspense>
            <OrbitControls makeDefault enableDamping />
            <GizmoHelper alignment="top-right" margin={[52, 52]}>
              <GizmoViewport
                axisColors={["#e56b6b", "#6bcb77", "#4d8fe5"]}
                labelColor="white"
              />
            </GizmoHelper>
            <InspectionCapturer
              request={inspection}
              onCaptured={onInspectionCaptured}
            />
          </Canvas>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-ink-subtle">
            This asset has no renderable model output
          </div>
        )}
      </div>
    </Panel>
  );
});
