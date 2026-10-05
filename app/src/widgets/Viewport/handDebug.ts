import { createHandDetectionState, interpretDetections } from "./handDetections";
import { HAND_LANDMARK_COUNT, pinchRatio, type HandLandmark, type PhysicalHand } from "./handLandmarks";
import type { HandTrackingStore } from "./handTrackingStore";
import { resolveHandTrackingSource } from "./useHandTracking";

/**
 * 手势模式的**诊断口**：只在**开发构建 + `?handDebug=1`** 时把 `window.__HAND__` 装上。
 *
 * ### 为什么必须有它（而不是靠单测）
 * 单测能钉住纯数学（映射、捏合、骨段位姿），**证明不了真机行为**：手在场景里到底有没有出现、
 * 关节的世界坐标对不对、捏合有没有真的把模型搬走。而这条通路唯一的前提——**摄像头**——
 * 在自动化沙箱里拿不到（Chrome 的假设备只给一张彩条图，MediaPipe 在里面找不到手）。
 * 所以拆成两半，各自都能在真实浏览器里验：
 *   ① `inject()`：喂一组**合成关键点**，绕过摄像头，验"关键点 → 3D 手 → 捏合 → 搬运/落盘"；
 *   ② `detectOnImage(url)`：在**真实照片**上跑一次真正的 HandLandmarker（IMAGE 模式），
 *      验"wasm + 模型 + 检测"这条链是通的。两者合起来覆盖了除"摄像头本身"之外的全部路径。
 *
 * ### 纪律（与 `physicsDebug.ts` 逐条相同）
 * ① 生产构建与不带参数的页面**一律不装**；② 组件内部要用这些能力必须走自己的引用，
 * 不能绕 `window` 上那个回调自己（一加开关，产品路径就静默失效）。
 */

/** 合成手的形状参数 */
export interface SyntheticHandOptions {
  /** 手掌中心在**归一化画面**里的位置（x 向右、y 向下，0..1） */
  center: readonly [number, number];
  /**
   * 捏住还是张开。
   * 捏住时拇指尖被搬到食指尖旁边——`pinchRatio` 因此落到 `PINCH_START_RATIO` 以下，
   * 走的是产品里那套迟滞判据（不是直接写一个 `pinching = true`）。
   */
  pinched?: boolean;
  /** 手的整体尺度（归一化，1 = 掌长约 0.15 个画面宽度）。默认 1 */
  scale?: number;
  /** 水平镜像（给左右手不同的姿态，参考图里两只手朝向不同） */
  mirror?: boolean;
}

/**
 * 张开的手（右手背朝镜头）的 21 个点，**相对手掌中心**、单位是"掌长的 1/0.15"。
 *
 * 坐标约定与 MediaPipe 一致：**图像归一化坐标，y 向下**——所以腕在下（y 为正）、指尖在上
 * （y 为负）。第一版把腕写成负 y，注入之后整只手在画面里是**倒的**（腕在上、手指垂下来）；
 * 纯数值的判据（掌长、捏合比值）全都不会发现这一点，只有真机截图能看出来。
 */
const OPEN_HAND_TEMPLATE: readonly (readonly [number, number, number])[] = [
  [0, 0.09, 0], // 0  wrist
  [-0.045, 0.05, -0.005], // 1  thumb cmc
  [-0.075, 0.02, -0.01], // 2  thumb mcp
  [-0.095, -0.005, -0.012], // 3  thumb ip
  [-0.11, -0.028, -0.014], // 4  thumb tip
  [-0.035, -0.055, 0], // 5  index mcp
  [-0.04, -0.105, 0], // 6  index pip
  [-0.042, -0.135, 0], // 7  index dip
  [-0.044, -0.161, 0], // 8  index tip
  [0, -0.06, 0], // 9  middle mcp
  [0, -0.116, 0], // 10 middle pip
  [0, -0.146, 0], // 11 middle dip
  [0, -0.171, 0], // 12 middle tip
  [0.035, -0.055, 0], // 13 ring mcp
  [0.038, -0.106, 0], // 14 ring pip
  [0.04, -0.133, 0], // 15 ring dip
  [0.041, -0.157, 0], // 16 ring tip
  [0.068, -0.04, 0], // 17 pinky mcp
  [0.075, -0.081, 0], // 18 pinky pip
  [0.078, -0.103, 0], // 19 pinky dip
  [0.08, -0.122, 0], // 20 pinky tip
];

/**
 * 模板单位 → 归一化画面单位。
 *
 * 模板的掌长是 0.15（腕 y=−0.09 到中指 MCP y=0.06），而"一只手在画面里"的掌长大约是
 * 画面宽度的 0.12（正常坐在摄像头前的距离）。所以 0.8 这个系数让 `scale = 1` 的手看起来
 * 就是参考图里那个大小。
 */
const NORMALIZED_PER_TEMPLATE_UNIT = 0.8;

/**
 * 生成一组"看起来像手"的关键点。**纯函数**：单测与真机探针用的是同一份形状，
 * 所以"单测里捏合判据成立"与"浏览器里手真的抓起来了"讲的是同一件事。
 */
export function syntheticHandLandmarks(options: SyntheticHandOptions): HandLandmark[] {
  const { center, pinched = false, scale = 1, mirror = false } = options;
  const points = OPEN_HAND_TEMPLATE.map((point) => ({ x: point[0], y: point[1], z: point[2] }));

  if (pinched) {
    // 拇指尖（4）搬到食指尖（8）附近，指节（3）跟着走一半：捏合程度由几何自己说话
    const target = points[8]!;
    points[4] = { x: target.x - 0.008, y: target.y + 0.004, z: target.z + 0.028 };
    points[3] = {
      x: (points[3]!.x + points[4].x) / 2,
      y: (points[3]!.y + points[4].y) / 2,
      z: points[3]!.z - 0.01,
    };
  }

  const unit = scale * NORMALIZED_PER_TEMPLATE_UNIT;
  return points.slice(0, HAND_LANDMARK_COUNT).map((point) => ({
    x: center[0] + (mirror ? -point.x : point.x) * unit,
    y: center[1] + point.y * unit,
    z: point.z * unit,
  }));
}

/** 合成关键点的捏合比值（诊断口/单测用来断言"这组点确实算捏住/张开"） */
export function syntheticPinchRatio(options: SyntheticHandOptions): number {
  return pinchRatio(syntheticHandLandmarks(options));
}

export interface HandDebugStatus {
  status: string;
  error: string | null;
  fps: number;
  handCount: number;
  detectMs: number;
  source: string | null;
  forced: boolean;
}

export interface HandDebugApi {
  status(): HandDebugStatus;
  /**
   * 注入一组合成关键点（绕过摄像头）。调用即"接管"：`forced` 置真，手会真的被画进场景。
   * @param kind 张开 / 捏住
   * @param center 手掌中心在归一化画面里的位置（默认交给调用方按目标模型算）
   * @param hand 放到哪只手的槽位上
   */
  inject(options: {
    kind: "open" | "pinch";
    center: readonly [number, number];
    hand?: PhysicalHand;
    scale?: number;
  }): { pinchRatio: number; hands: number };
  /** 撤掉注入（手回到"没有被追踪"的状态） */
  clear(): void;
  /** 产品路径算出来的那支射线（相机 → 捏合点） */
  pointer(): unknown;
  /**
   * 强制渲染若干帧（每帧之间隔一次 rAF）。
   * 诊断"检测结果到手了但画面没重画"这类问题：`frameloop="demand"` 下每帧都要有人要。
   */
  pump(frames?: number): number;
  /** **引擎事实**：手分组的世界位置、关节世界坐标、可见性、网格计数（不是我们自己的记账） */
  pose(): unknown;
  /**
   * 在**一张真实照片**（URL 或 data: URL）上跑一次真正的 HandLandmarker（IMAGE 模式）。
   * 用来证明 wasm + 模型 + 检测这条链在真实浏览器里是通的；publish 可将结果送入实际 HandRig。
   */
  detectOnImage(url: string, options?: { publish?: boolean }): Promise<{ hands: number; landmarks: number; handedness: string[]; ms: number }>;
}

const DEBUG_KEY = "__HAND__";

let forced = false;
let probe: (() => unknown) | null = null;

/** HandRig 每帧读它：诊断注入时手也要被画出来（不需要 React 重渲染） */
export function isHandDebugForced(): boolean {
  return forced;
}

/** HandRig 注册"读引擎事实"的函数（与 `physicsDebug.setGrabHandles` 同形状） */
export function setHandProbe(next: (() => unknown) | null): void {
  probe = next;
}

export function handDebugEnabled(search: string): boolean {
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  if (env?.DEV !== true) return false;
  return /[?&]handDebug=1(?:&|$)/.test(search);
}

export function installHandDebug({ store }: { store: HandTrackingStore }): () => void {
  if (typeof window === "undefined") return () => {};
  const target = window as unknown as Record<string, unknown>;

  const api: HandDebugApi = {
    status: () => ({
      ...store.getSnapshot(),
      forced,
    }),
    inject: ({ kind, center, hand = "right", scale = 1 }) => {
      forced = true;
      // 检测循环正在 30–60 Hz 地覆盖同一份 frame：不上锁的话注入的手只活到下一帧检测结果
      store.setDetectionLock(true);
      const landmarks = syntheticHandLandmarks({ center, pinched: kind === "pinch", scale, mirror: hand === "left" });
      const ratio = pinchRatio(landmarks);
      const frame = store.getFrame();
      store.publishInjectedFrame({
        hands: [
          {
            landmarks,
            // 合成诊断坐标，仅检查接线；不是摄像头的米制观测。
            worldLandmarks: landmarks.map((point) => ({ ...point })),
            physical: hand,
            pinching: kind === "pinch",
            pinchRatio: ratio,
            confidence: 1,
          },
        ],
        frameId: frame.frameId + 1,
        timestampMs: performance.now(),
        detectMs: 0,
      });
      // 画布是 demand 模式：注入之后必须显式要一帧，否则场景不会重画
      store.requestFrame();
      return { pinchRatio: ratio, hands: 1 };
    },
    clear: () => {
      forced = false;
      store.setDetectionLock(false);
      store.publishInjectedFrame({ hands: [], frameId: store.getFrame().frameId + 1, timestampMs: performance.now(), detectMs: 0 });
      store.setPointer(null);
      store.requestFrame();
    },
    pointer: () => store.getPointer(),
    pump: (frames = 3) => {
      let count = 0;
      const step = () => {
        store.requestFrame();
        count += 1;
        if (count < frames) requestAnimationFrame(step);
      };
      step();
      return frames;
    },
    pose: () => probe?.() ?? null,
    detectOnImage: async (url: string, options = {}) => {
      const vision = await import("@mediapipe/tasks-vision");
      const source = resolveHandTrackingSource(
        typeof location === "undefined" ? "" : location.search,
      );
      const fileset = await vision.FilesetResolver.forVisionTasks(source.wasmBase);
      const started = performance.now();
      const task = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: source.modelUrl, delegate: "GPU" },
        runningMode: "IMAGE",
        numHands: 2,
      });
      try {
        const image = await loadImage(url);
        const result = task.detect(image);
        if (options.publish) {
          forced = true;
          store.setDetectionLock(true);
          const now = performance.now();
          const hands = interpretDetections(result.landmarks.map((landmarks, index) => ({
            landmarks,
            worldLandmarks: result.worldLandmarks[index],
            handedness: result.handedness[index] ?? [],
          })), createHandDetectionState(), now);
          store.publishInjectedFrame({ hands, frameId: store.getFrame().frameId + 1, timestampMs: now, detectMs: now - started });
          store.requestFrame();
        }
        return {
          hands: result.landmarks.length,
          landmarks: result.landmarks[0]?.length ?? 0,
          handedness: result.handedness.map((categories) => categories[0]?.categoryName ?? ""),
          ms: Math.round(performance.now() - started),
        };
      } finally {
        task.close();
      }
    },
  };

  target[DEBUG_KEY] = api;
  return () => {
    delete target[DEBUG_KEY];
    forced = false;
    probe = null;
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image failed to load"));
    image.src = url;
  });
}
