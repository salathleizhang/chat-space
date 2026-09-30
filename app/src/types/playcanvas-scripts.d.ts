/**
 * `playcanvas/scripts/**` 是**可选脚本层**，发布包里没有 `.d.ts`（只有引擎主体
 * `build/playcanvas.d.ts`）。这里按实际用法给出最小声明，而不是用 `any`——
 * 构造签名写错时应当编译失败。
 */
declare module "playcanvas/scripts/esm/parsers/spz-parser.mjs" {
  import type { AppBase } from "playcanvas";
  /** SPZ（nianticlabs/spz）格式的资源解析器，**只支持 version 4**，需先注册 ZSTD 解码器。 */
  export class SpzParser {
    constructor(app: AppBase);
  }
}
