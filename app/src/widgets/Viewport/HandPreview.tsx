import { useEffect, useRef, type RefObject } from "react";
import { HAND_CONNECTIONS, HAND_LANDMARK_COUNT } from "./handLandmarks";
import { handStatusLabel, handStatusTone, useHandTrackingSnapshot, type HandTrackingStore } from "./handTrackingStore";

/**
 * 摄像头预览小窗（参考图右上角那一块）：同一路流既喂检测器也给人看，
 * 上面再叠一层**2D 关键点**。
 *
 * ### 为什么必须叠关键点
 * "看不到手"是这套功能最容易出现、也最难自己判断的故障，而它至少有四种完全不同的原因：
 * ① 摄像头没起来；② 检测循环没在出结果；③ 检测到了但 3D 网格没被画出来；④ 画面里真的没有手。
 * 四种在用户眼里长得一模一样。这层 2D 关键点把①③④一眼分开：
 * **预览上有点 ⇒ 检测是好的**，若场景里仍无手，问题就只在渲染那一侧（见 `HandRig` 的续帧说明）。
 * 它同时是"镜像/手性对不对"最直观的读数：看到的骨架应当与镜子里的自己重合。
 *
 * ### 三条纪律
 * 1. **整块 `pointer-events-none`**：它是叠在画布上的悬浮层，吃掉指针事件就等于
 *    "画布右上角点不动了"（视图拖拽/拾取都在那个位置）。模式开关在右下角工具栏上，
 *    这里不需要任何可点控件。
 * 2. **视频镜像显示**（`-scale-x-100`），而 MediaPipe 吃的是原始帧 ⇒ 画关键点时 x 要翻一次
 *    （`1 − x`），否则骨架与画面里的人会左右错开，看着像"检测错了"。
 * 3. **只在有新的一帧时重画**：rAF 每帧都跑，但 `frameId` 没变就不动笔（与 `frameloop` 同口径）。
 */
export function HandPreview({
  store,
  videoRef,
  visible,
}: {
  store: HandTrackingStore;
  videoRef: RefObject<HTMLVideoElement | null>;
  visible: boolean;
}) {
  const snapshot = useHandTrackingSnapshot(store);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    let lastFrameId = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const frame = store.getFrame();
      if (frame.frameId === lastFrameId) return;
      lastFrameId = frame.frameId;
      const context = canvas.getContext("2d");
      if (!context) return;
      const { width, height } = canvas;
      context.clearRect(0, 0, width, height);
      for (const hand of frame.hands) {
        const points = hand.landmarks;
        if (points.length !== HAND_LANDMARK_COUNT) continue;
        // 视频是镜像显示的（`-scale-x-100`），关键点来自原始帧 ⇒ 画的时候 x 要翻一次
        const px = (point: { x: number; y: number }) => [(1 - point.x) * width, point.y * height] as const;
        context.lineWidth = 1.5;
        context.strokeStyle = hand.pinching ? "rgba(116, 240, 138, 0.95)" : "rgba(255, 255, 255, 0.75)";
        context.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          const from = points[a];
          const to = points[b];
          if (!from || !to) continue;
          const [x1, y1] = px(from);
          const [x2, y2] = px(to);
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
        }
        context.stroke();
        context.fillStyle = hand.pinching ? "#74f08a" : "#ffd166";
        for (const point of points) {
          const [x, y] = px(point);
          context.beginPath();
          context.arc(x, y, 1.8, 0, Math.PI * 2);
          context.fill();
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store, visible]);

  if (!visible) return null;

  const tone = handStatusTone(snapshot);
  const dotClass = tone === "live" ? "bg-emerald-400" : tone === "error" ? "bg-red-400" : "bg-amber-300";
  const label = handStatusLabel(snapshot);

  return (
    <div
      data-hand-preview=""
      className="pointer-events-none absolute top-4 right-4 z-20 w-[212px] animate-chrome-enter select-none"
    >
      <div className="relative overflow-hidden rounded-lg bg-black ring-1 ring-hairline">
        {/*
          `muted` + `playsInline` 是自动播放的前提（getUserMedia 的流本身允许静音自动播放）；
          `autoPlay` 只在挂载那一次起作用，流是之后才赋给 srcObject 的——所以驱动的其实是
          `useHandTracking` 里的 `video.play()`。
        */}
        <video
          ref={videoRef}
          className="h-[119px] w-full -scale-x-100 object-cover"
          muted
          autoPlay
          playsInline
        />
        {/* 关键点叠层：与视频同一个盒子；视频镜像了，所以这里按 (1−x) 画 */}
        <canvas ref={canvasRef} width={320} height={180} className="absolute inset-0 h-full w-full" />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-1 px-2 py-1 text-[10px] font-medium tracking-wide text-white/90">
          <span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5">
            <span className={`size-1.5 rounded-full ${dotClass}`} />
            WEBCAM · TASKS-VISION
          </span>
          <span className="rounded-full bg-black/55 px-1.5 py-0.5 tabular-nums">
            {snapshot.status === "running" ? `${snapshot.fps} fps` : "—"}
          </span>
        </div>
        {snapshot.status !== "running" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-3 text-center text-[11px] leading-snug text-white/85">
            {label}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 px-0.5 text-[11px] text-ink-subtle">
        <span className="truncate">
          {snapshot.status === "running" ? `${label} · ${snapshot.handCount}` : "Hand tracking"}
        </span>
        {snapshot.status === "running" && (
          <span className="shrink-0 tabular-nums">
            {/*
              检测健康度：单帧失败不致命（循环会继续），一直失败才是"看不到手"的真因——
              所以把抛错次数与"已经出了多少帧"都摆出来。`0 frames` 不涨 = 检测循环没在出结果。
            */}
            {snapshot.detectErrors > 0 ? `${snapshot.detectErrors}× err` : `${snapshot.published} frames`}
          </span>
        )}
      </div>
    </div>
  );
}
