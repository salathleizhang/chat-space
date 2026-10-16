import { useEffect } from "react";
import type { HandLandmarker, HandLandmarkerResult } from "@mediapipe/tasks-vision";
import {
  HAND_CDN_SOURCE,
  HAND_LOCAL_SOURCE,
  isLocalHandSource,
  type HandTrackingSource,
} from "./handAssets";
import { createHandDetectionState, interpretDetections } from "./handDetections";
import type { HandTrackingStore } from "./handTrackingStore";

/**
 * 手势模式的**副作用层**：开摄像头 → 起 MediaPipe HandLandmarker → 每帧检测 → 写进 store。
 *
 * ### 依赖从哪来
 * - **js 运行时走 npm 包**（`@mediapipe/tasks-vision`，锁在 `app/package.json`），不是往页面里插
 *   `<script src="...vision_bundle.mjs">`：包版本与类型都由 lockfile 管，构建也不需要联网。
 * - **wasm 与模型现在同源**（`/mediapipe/<版本>/...`，随产物发出、`immutable` 长缓存；
 *   见 `handAssets.ts` 与 `app/public/mediapipe/README.md`）。**第三方只剩兜底**：
 *   同源加载失败时才按 `HAND_CDN_SOURCE`（jsDelivr 的 wasm + Google bucket 的模型）重试一次。
 *   这条兜底同时兜住两件事——资产没被正确部署，以及"只随包发了 SIMD 那一套"在不支持
 *   wasm SIMD 的环境下的 404。
 * - 仍然可以用 `?handWasm=` / `?handModel=` 显式指定来源；**用户显式指定时不再偷偷换源**。
 *   版本号与 `app/package.json` 的 `@mediapipe/tasks-vision` **必须同版本**：wasm 与 js 的接口在
 *   0.10.x 里改过（见 `handAssets.ts` 的 `HAND_ASSET_VERSION`），错配的症状是"模型加载到一半
 *   报无意义的 `RuntimeError`"。真机验证时以"能不能真的检测出手"为准，不以"没有报错"为准。
 *
 * ### 为什么检测跑在自己的 rAF 里，而不是 R3F 的 `useFrame`
 * 摄像头是 30 fps、渲染是 60 fps，两者不该互相决定节奏；而且检测是**同步阻塞**的
 * （wasm 在 CPU/GPU 上算完才返回），放进渲染帧里会直接吃掉帧时间。分开之后渲染循环只在
 * "有新的一帧结果"时叫醒渲染循环一次（画布是 `frameloop="demand"`，见 store 的
 * `setFrameRequester`）。
 */

/** 同时追踪两只手（参考图里就是双手） */
export const HAND_NUM_HANDS = 2;

/**
 * 两次检测之间的最小间隔（毫秒）：60 fps 上限。
 * 摄像头通常给 30 fps，`detectForVideo` 对同一帧重复调用只是白烧 CPU；同时它**要求时间戳
 * 严格递增**，重复时间戳会抛异常。
 */
export const HAND_DETECT_MIN_INTERVAL_MS = 1000 / 60;

/** 来源类型在 `handAssets.ts`（那里也是默认值与兜底值的唯一出处），这里只转发一次 */
export type { HandTrackingSource } from "./handAssets";

/**
 * 解析 wasm 与模型的来源（纯函数，单测钉住覆盖优先级）。
 * 覆盖参数：`?handWasm=<目录 URL>`、`?handModel=<模型 URL>`。**默认是同源资产**。
 */
export function resolveHandTrackingSource(search: string): HandTrackingSource {
  let wasmBase = HAND_LOCAL_SOURCE.wasmBase;
  let modelUrl = HAND_LOCAL_SOURCE.modelUrl;
  try {
    const params = new URLSearchParams(search ?? "");
    const wasm = params.get("handWasm");
    if (wasm) wasmBase = wasm.replace(/\/$/, "");
    const model = params.get("handModel");
    if (model) modelUrl = model;
  } catch {
    // search 不是合法 query 时用默认值，绝不让诊断参数把整个视口弄崩
  }
  return { wasmBase, modelUrl };
}

/**
 * 主来源失败后还要试哪些来源（按顺序）。
 *
 * 只在**默认来源**上挂兜底：用户用 `?handWasm=` / `?handModel=` 明确指了地方的时候，
 * 悄悄换到 CDN 会让他以为自己的覆盖生效了（而实际读的是别人的文件），那种"静默换源"
 * 比加载失败更难查。
 *
 * 兜底**不是可选的美化**：只随包发 SIMD 那一套 wasm，非 SIMD 环境会同源 404；
 * 资产漏部署（比如 `app/public/mediapipe/` 没进产物）时也是这条把它接住。
 */
export function handTrackingFallbacks(search: string): HandTrackingSource[] {
  return isLocalHandSource(resolveHandTrackingSource(search)) ? [HAND_CDN_SOURCE] : [];
}

/** 相机错误的用户可读文案（这几句话会出现在预览小窗里，单测钉住） */
export function describeCameraError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera found";
    case "NotReadableError":
      return "Camera is in use by another app";
    default:
      return "Could not start the camera";
  }
}

/** MediaPipe 加载失败的文案 */
export function describeModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message ? `Hand model failed: ${message.slice(0, 120)}` : "Hand model failed to load";
}

export interface UseHandTrackingOptions {
  enabled: boolean;
  store: HandTrackingStore;
  /** 预览小窗里那个 `<video>`（同一路流既给用户看，也给检测器吃） */
  videoRef: { readonly current: HTMLVideoElement | null };
  /** 起始地址的 query（默认取 `location.search`），用于 `?handWasm=` / `?handModel=` */
  search?: string;
}

/**
 * 挂了就一直跟着 `enabled` 起停：关掉时**必须**把摄像头轨道与 wasm 任务一起释放
 * （不释放的话相机指示灯不灭，用户会以为程序在偷看）。
 */
export function useHandTracking({
  enabled,
  store,
  videoRef,
  search,
}: UseHandTrackingOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const effectiveSearch = search ?? (typeof location === "undefined" ? "" : location.search);
    /** 主来源 + 兜底（默认是同源资产，兜底是第三方；用户显式覆盖时没有兜底） */
    const primary = resolveHandTrackingSource(effectiveSearch);
    const candidates = [primary, ...handTrackingFallbacks(effectiveSearch)];
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let landmarker: HandLandmarker | null = null;
    let lastDetectAt = 0;
    let lastTimestamp = -1;
    /*
      **动态检测间隔**：`detectForVideo` 是同步的，慢帧会把整个主线程按住
      （用户报的"手不跟着相机走"最可能就是它——几帧之内页面完全冻结，相机转了、手不动）。
      所以单帧超过 40 ms 就把间隔放宽到 1/10 s：宁可少出几帧结果，也要让渲染与相机保持跟手。
    */
    let detectInterval = HAND_DETECT_MIN_INTERVAL_MS;
    let frameId = 0;
    const detections = createHandDetectionState();

    const stopCamera = () => {
      if (!stream) return;
      for (const track of stream.getTracks()) track.stop();
      stream = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      const task = landmarker;
      if (!video || !task) return;
      // readyState < 2 = 还没有可用帧；videoWidth = 0 时 detectForVideo 会读到空画面
      if (video.readyState < 2 || video.videoWidth === 0) return;
      const now = performance.now();
      if (now - lastDetectAt < detectInterval) return;
      // 时间戳必须严格递增，否则 MediaPipe 直接抛错
      if (now <= lastTimestamp) return;
      lastDetectAt = now;
      lastTimestamp = now;

      const started = performance.now();
      let result: HandLandmarkerResult;
      try {
        result = task.detectForVideo(video, now);
      } catch (error) {
        // 单帧失败（尺寸刚变、上下文丢失）不该杀掉整个循环：下一帧再试。
        // 但**必须留下痕迹**：一直抛错时用户只会看到"没有手"，而 `noteDetectError`
        // 让诊断口与预览小窗能回答"检测循环到底有没有在出结果"。
        store.noteDetectError(error);
        return;
      }
      const detectMs = performance.now() - started;
      detectInterval = detectMs > 40 ? 100 : HAND_DETECT_MIN_INTERVAL_MS;
      const hands = interpretDetections(
        result.landmarks.map((landmarks, index) => ({
          landmarks,
          worldLandmarks: result.worldLandmarks?.[index],
          handedness: result.handedness?.[index] ?? [],
        })),
        detections,
        now,
      );
      frameId += 1;
      // `publishFrame` 自己会叫醒渲染循环（见 store 的 `setFrameRequester`）
      store.publishFrame({ hands, frameId, timestampMs: now, detectMs });
    };

    const start = async () => {
      store.setStatus("requesting", null, `${primary.wasmBase} · ${primary.modelUrl}`);
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        store.setStatus("error", "This browser has no camera API");
        return;
      }
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
          audio: false,
        });
      } catch (error) {
        if (!cancelled) store.setStatus("error", describeCameraError(error));
        return;
      }
      if (cancelled) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream = media;
      const video = videoRef.current;
      if (!video) {
        if (!cancelled) store.setStatus("error", "Camera preview is not mounted");
        return;
      }
      video.srcObject = media;
      video.muted = true;
      video.playsInline = true;
      try {
        await video.play();
      } catch {
        // 自动播放被拒（极少见：muted 的流允许自动播放）。检测仍可能拿到帧，所以不判死。
      }
      if (cancelled) return;

      store.setStatus("loading");
      let task: HandLandmarker | null = null;
      let failure: unknown = null;
      const options = {
        runningMode: "VIDEO" as const,
        numHands: HAND_NUM_HANDS,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      };
      try {
        const vision = await import("@mediapipe/tasks-vision");
        /*
          按候选来源依次试：同源资产（默认）→ CDN（兜底）。两个来源都失败才判错。
          每一轮都显式写 `source`，这样面板上显示的是**实际**生效的那一份——
          兜底悄悄生效而面板还写着同源路径的话，"为什么它变慢了"就无从判断了。
        */
        for (const candidate of candidates) {
          if (cancelled) break;
          store.setStatus("loading", null, `${candidate.wasmBase} · ${candidate.modelUrl}`);
          try {
            const fileset = await vision.FilesetResolver.forVisionTasks(candidate.wasmBase);
            /*
              GPU 委托（内部走 WebGL/WebGPU 的 shader）在少数环境里建不起来（显卡被占用、
              无头容器）。那时退到 CPU：慢一些，但功能是好的——比"整个模式用不了"强。
            */
            try {
              task = await vision.HandLandmarker.createFromOptions(fileset, {
                ...options,
                baseOptions: { modelAssetPath: candidate.modelUrl, delegate: "GPU" },
              });
            } catch {
              task = await vision.HandLandmarker.createFromOptions(fileset, {
                ...options,
                baseOptions: { modelAssetPath: candidate.modelUrl, delegate: "CPU" },
              });
            }
            break;
          } catch (error) {
            failure = error;
          }
        }
      } catch (error) {
        // 动态 import 自己失败（chunk 404 / 语法错）也算这一层
        failure = error;
      }
      if (!task) {
        if (!cancelled) store.setStatus("error", describeModelError(failure));
        stopCamera();
        return;
      }
      if (cancelled) {
        task.close();
        return;
      }
      /*
        **预热**：`detectForVideo` 的第一次调用要把 wasm 的着色器编译出来，
        本机实测 **8–52 秒**（GPU 委托；见 `.tmp/hand-verify/ask-handedness.mjs` 的读数）。
        放在这里冻的是"Loading hand model…"这一屏——用户预期就是在等；
        放进循环里冻的就是"Tracking 中"的实时交互，看起来完全像坏了。
      */
      try {
        const warmup = document.createElement("canvas");
        warmup.width = 64;
        warmup.height = 64;
        warmup.getContext("2d")?.fillRect(0, 0, 64, 64);
        task.detectForVideo(warmup, performance.now());
      } catch {
        // 预热失败不影响后面的循环（真出问题会在循环里被记进 detectErrors）
      }
      landmarker = task;
      store.setStatus("running");
      raf = requestAnimationFrame(loop);
    };

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      // 顺序：先停检测（不让它再碰视频帧），再关摄像头，最后释放 wasm 任务
      landmarker?.close();
      landmarker = null;
      stopCamera();
      store.setPointer(null);
    };
  }, [enabled, search, store, videoRef]);
}
