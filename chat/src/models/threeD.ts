import { config } from "../config";
import { SEED3D_MODEL } from "./seed3d";
import { TRIPO_P1_MODEL, TRIPO_P2_MODEL } from "./tripo";

/**
 * 可选的 3D 生成模型注册表。界面选的是「具体模型」，不是渠道：条目同时决定
 * 走哪条渠道、以及提交给供应商的模型 ID。
 *
 * 选择键（selection）是稳定契约，模型 ID 才允许被 env 覆盖——所以键不能等于
 * 模型 ID：`VOLC_HYPER3D_MODEL` 等一旦改写，用模型 ID 当键的请求就会解析不到。
 * 前端 `THREE_D_MODEL_PRESETS` 与本表的键、显示名逐字对应。
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
}

export const THREE_D_MODELS = {
  "seed3d-2": {
    label: "Seed3D 2.0",
    provider: "seed3d-direct",
    model: SEED3D_MODEL,
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
