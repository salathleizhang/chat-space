import { ChatServiceError } from "../common/errors";
import { config } from "../config";
import { SEED3D_MODEL, type Seed3dSubdivisionLevel } from "./seed3d";
import { TRIPO_P1_MODEL, TRIPO_P2_MODEL } from "./tripo";

/**
 * 可选的 3D 生成模型注册表。界面选的是「具体模型」，不是渠道：条目同时决定
 * 走哪条渠道、以及提交给供应商的模型 ID。
 *
 * 选择键（selection）是稳定契约，模型 ID 才允许被 env 覆盖——所以键不能等于
 * 模型 ID：`VOLC_HYPER3D_MODEL` 等一旦改写，用模型 ID 当键的请求就会解析不到。
 * 前端 `THREE_D_MODEL_PRESETS` 与本表的键、显示名逐字对应。
 *
 * **当前开放的是火山方舟那三个**（Seed3D / 影眸 Hyper3D / 数美 Hi3D）。Tripo 的条目
 * 保留是为了读旧任务与侧写，不再参与新生成：Tripo 积分已用尽，`generationModelFor`
 * 会把已关闭的选择回退到默认模型。
 */
export const THREE_D_PROVIDER_IDS = [
  "seed3d-direct",
  "hyper3d-volc",
  "hi3d-volc",
  "tripo-direct",
] as const;
export type ThreeDProviderId = (typeof THREE_D_PROVIDER_IDS)[number];

export interface ThreeDModelEntry {
  /** 界面显示的具体模型名 */
  label: string;
  /** 实际调用渠道 */
  provider: ThreeDProviderId;
  /** 提交给供应商的模型 ID（Hyper3D / Hi3D / Tripo 可用 env 覆盖，Seed3D 暂不可） */
  model: string;
  /** Seed3D 专有的细分档；高/中/低分别约 100 万 / 50 万 / 10 万三角面 */
  subdivision?: Seed3dSubdivisionLevel;
}

export const THREE_D_MODELS = {
  "seed3d-2": {
    label: "Seed3D 2.0",
    provider: "seed3d-direct",
    model: SEED3D_MODEL,
    subdivision: "medium",
  },
  "hyper3d-gen2": {
    label: "Hyper3D Gen-2",
    provider: "hyper3d-volc",
    model: config.ark3d.hyper3dModel,
  },
  "hi3d-2": {
    label: "Hi3D 2.0",
    provider: "hi3d-volc",
    model: config.ark3d.hi3dModel,
  },
  "tripo-3-1": {
    label: "Tripo 3.1",
    provider: "tripo-direct",
    model: config.tripo.imageModel,
  },
  "tripo-p1": {
    label: "Tripo P1",
    provider: "tripo-direct",
    model: TRIPO_P1_MODEL,
  },
  "tripo-p2": {
    label: "Tripo P2",
    provider: "tripo-direct",
    model: TRIPO_P2_MODEL,
  },
} as const satisfies Record<string, ThreeDModelEntry>;

export type ThreeDModelSelection = keyof typeof THREE_D_MODELS;

/** 当前产品开放的模型（Tripo 积分用尽后下线）。 */
export const ENABLED_THREE_D_MODEL_SELECTIONS = [
  "seed3d-2",
  "hyper3d-gen2",
  "hi3d-2",
] as const;
export type EnabledThreeDModelSelection = (typeof ENABLED_THREE_D_MODEL_SELECTIONS)[number];

export const DEFAULT_THREE_D_MODEL: EnabledThreeDModelSelection = "seed3d-2";

export const THREE_D_MODEL_SELECTIONS = Object.keys(THREE_D_MODELS) as [
  ThreeDModelSelection,
  ...ThreeDModelSelection[],
];

/** 未注册的选择键返回 undefined，让调用方回退到 agent 自己的判断。 */
export function threeDModelFor(selection: unknown): ThreeDModelEntry | undefined {
  return typeof selection === "string" &&
    Object.hasOwn(THREE_D_MODELS, selection)
    ? THREE_D_MODELS[selection as ThreeDModelSelection]
    : undefined;
}

export function isEnabledThreeDModel(selection: unknown): selection is EnabledThreeDModelSelection {
  return (
    typeof selection === "string" &&
    (ENABLED_THREE_D_MODEL_SELECTIONS as readonly string[]).includes(selection)
  );
}

export interface ResolvedThreeDModel {
  key: EnabledThreeDModelSelection;
  entry: ThreeDModelEntry;
}

/**
 * 把界面选择解析成实际要调的模型。
 *
 * **已下线的选择（例如用户以前存过的 `tripo-3-1`）回退到默认模型，不抛错**：否则一条
 * 旧设置会让整个会话在构造上下文时就失败。真正需要拒绝的场景（HTTP 显式指定渠道、
 * 重试非启用渠道）由调用方各自校验。
 */
export function generationModelFor(selection: unknown): ResolvedThreeDModel {
  const key = isEnabledThreeDModel(selection) ? selection : DEFAULT_THREE_D_MODEL;
  return { key, entry: THREE_D_MODELS[key] };
}

/** 渠道 → 该渠道默认启用的模型（HTTP 只给渠道时用）。 */
export function modelForProvider(provider: string): ThreeDModelEntry | undefined {
  const key = (ENABLED_THREE_D_MODEL_SELECTIONS as readonly string[]).find(
    (candidate) => THREE_D_MODELS[candidate as EnabledThreeDModelSelection].provider === provider,
  );
  return key ? THREE_D_MODELS[key as EnabledThreeDModelSelection] : undefined;
}

/** 渠道 → 该渠道需要哪把 key。 */
export function threeDProviderKeyName(
  provider: ThreeDProviderId,
): "seed3dApiKey" | "tripo3dApiKey" {
  return provider === "tripo-direct" ? "tripo3dApiKey" : "seed3dApiKey";
}

/** 渠道 → 缺 key 时该报哪条环境变量（本机 `.env` 里的名字）。 */
export function threeDProviderKeyEnv(provider: ThreeDProviderId): "VOLC_KEY" | "TRIPO_KEY" {
  return provider === "tripo-direct" ? "TRIPO_KEY" : "VOLC_KEY";
}

export function assertEnabledThreeDModel(selection: string): asserts selection is EnabledThreeDModelSelection {
  if (!isEnabledThreeDModel(selection)) {
    throw new ChatServiceError(
      `Model "${selection}" is not enabled; generation now runs on Seed3D 2.0, Hyper3D Gen-2 and Hi3D 2.0`,
      409,
      "model_provider_disabled",
    );
  }
}
