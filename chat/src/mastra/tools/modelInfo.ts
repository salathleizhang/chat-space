import { glbTriangleCount } from "../../common/glb";
import type { AssetStorage } from "../../services/assetStorage";
import { latestAssetModel } from "./projectTools";

/**
 * 生成的模型有多重（面数）——**任务结果里就要有**，因为"要不要减面"这个决定发生在
 * 生成完成之后的那一轮：Agent 得先知道这是不是高模，才谈得上用 ask-user 问用户。
 *
 * 为什么不是让 Agent 自己判渠道/模型：Tripo 3.1 是 150 万面、P1/P2 是 5 千面，
 * 同一个渠道差三个数量级，靠名字猜迟早会猜错。读 GLB 的 JSON chunk 拿真实三角面数
 * （`glbTriangleCount`，不解码几何），判据就与供应商默认值无关。
 */

/**
 * "高模"的判据（三角面）。取 10 万的理由：
 * - 三个渠道的**高**档都在这个量级以上：Tripo H 系列约 140–150 万、Seed3D high/medium/low 是
 *   100 万 / 50 万 / **10 万**、Hyper3D 最高 100 万、Hi3D 要求 10 万起；
 * - 而低模产物远在其下：Tripo P 系列默认约 5 千面、用户显式要的 faceCount 也可能只有几千。
 * 所以这个阈值能把"值得问一次"的产物挑出来，同时不会为 P 系列那种低模去打扰用户。
 */
export const HIGH_POLY_FACE_THRESHOLD = 100_000;

export interface GeneratedModelInfo {
  /** 参与判定的产物（减面前的最新一代）；读不出模型时为 null */
  path: string | null;
  /** 实测三角面数；GLB 读不出来时是 null（含义是"不知道"，不是 0） */
  faces: number | null;
  /**
   * 要不要把它当高模处理（也就是要不要问用户减不减面）。
   * **面数未知时取 true**：这里问一次是免费的，漏问才是缺陷——用户要的正是"高模生成完自动问一句"，
   * 而能走到这里的三个渠道默认产出都是十万面以上（OBJ/FBX 这类读不出面数的产物同理）。
   */
  highPoly: boolean;
}

async function measureFaces(storage: AssetStorage, modelPath: string): Promise<number | null> {
  if (!/\.glb$/i.test(modelPath)) return null;
  try {
    return glbTriangleCount(await storage.readBytes(modelPath));
  } catch {
    return null;
  }
}

/**
 * 生成 + 在结果上补 `modelInfo`。**不抛异常**：量不出面数不该影响一次成功的生成，
 * 所以任何失败都退化成"不知道面数、按高模处理"。
 */
export async function runWithGeneratedModelInfo(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  generate: () => Promise<unknown>,
): Promise<unknown> {
  const result = await generate();
  const record =
    result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  let info: GeneratedModelInfo = { path: null, faces: null, highPoly: true };
  try {
    const modelPath = await latestAssetModel(storage, projectSlug, assetSlug);
    const faces = await measureFaces(storage, modelPath);
    info = {
      path: modelPath,
      faces,
      highPoly: faces === null || faces >= HIGH_POLY_FACE_THRESHOLD,
    };
  } catch {
    // 模型文件读不出来（异常落盘、目录还没提交）：保持"不知道 + 按高模处理"
  }
  return { ...record, modelInfo: info };
}
