import type { MaterialTextureSlot } from "../../lib/libraryApi";

/**
 * 材质覆盖：把右侧栏改过的**贴图槽位**写进模型材质（只换贴图，不换材质类）。
 *
 * ### 槽位名两边不是一套（引擎已核实，2026-10）
 * 应用的 `MaterialTextureSlot` 是 three 的名字；PlayCanvas `StandardMaterial` 是另一套，
 * 而且有两处**语义不同**，直接同名互喂必然画错：
 * - `roughnessMap` → **`glossMap` + `glossInvert = true`**：引擎的 gloss 是"光滑度"（roughness 的补），
 *   glTF 导入的材质会把 `glossInvert` 置真（`playcanvas.d.ts:17666-17670`），表示 glossMap 里存的
 *   是 roughness。不置这个标志，粗糙与光滑会对调（有光照时才看得出，很容易漏）。
 * - `alphaMap` → `opacityMap` + **`opacityMapChannel = "g"`**：three 的 alphaMap 默认读**绿**通道，
 *   PlayCanvas 默认读 alpha，不指定通道会把贴图当成全不透明。
 */
export interface PcMaterialSlotLike {
  [slot: string]: unknown;
}

export interface TextureSlotMapping {
  /** PlayCanvas 材质上的属性名 */
  property: string;
  /** 需要同时写的附加标志（例如 `glossInvert`） */
  flags?: Record<string, unknown>;
}

export const PC_SLOT_FOR_TEXTURE_SLOT: Readonly<Record<MaterialTextureSlot, TextureSlotMapping>> = {
  map: { property: "diffuseMap" },
  normalMap: { property: "normalMap" },
  roughnessMap: { property: "glossMap", flags: { glossInvert: true } },
  metalnessMap: { property: "metalnessMap" },
  aoMap: { property: "aoMap" },
  emissiveMap: { property: "emissiveMap" },
  alphaMap: { property: "opacityMap", flags: { opacityMapChannel: "g" } },
};

/** 记账表：材质 → （槽位 → 原值），只记**第一次**看到的值（同线框那条陷阱）。 */
export type MaterialOverrideLedger = Map<PcMaterialSlotLike, Record<string, unknown>>;

/** 把一张贴图写到材质上（含该槽位需要的附加标志）。返回是否真的改了。 */
export function writeMaterialTexture(
  material: PcMaterialSlotLike,
  slot: MaterialTextureSlot,
  texture: unknown,
): boolean {
  const mapping = PC_SLOT_FOR_TEXTURE_SLOT[slot];
  if (!mapping) return false;
  const changes: [string, unknown][] = [[mapping.property, texture]];
  for (const [key, value] of Object.entries(mapping.flags ?? {})) changes.push([key, value]);
  let changed = false;
  for (const [key, value] of changes) {
    if (material[key] !== value) { material[key] = value; changed = true; }
  }
  return changed;
}

/**
 * 应用一批覆盖（`overrides`：槽位 → 贴图）。**原值只记一次**——第二次进来把当前值（已经是覆盖）
 * 记成"原值"的话，还原时就永远回不去了（线框那条同款陷阱，只在开关两次后才显形）。
 */
export function applyMaterialOverrides(
  materials: readonly PcMaterialSlotLike[],
  overrides: Partial<Record<MaterialTextureSlot, unknown>>,
  ledger: MaterialOverrideLedger,
): number {
  let applied = 0;
  for (const material of materials) {
    let saved = ledger.get(material);
    if (!saved) { saved = {}; ledger.set(material, saved); }
    for (const [slot, texture] of Object.entries(overrides) as [MaterialTextureSlot, unknown][]) {
      const mapping = PC_SLOT_FOR_TEXTURE_SLOT[slot];
      if (!mapping) continue;
      // 记账：属性和它的附加标志都要记（还原时一起还）
      for (const key of [mapping.property, ...Object.keys(mapping.flags ?? {})]) {
        if (!(key in saved)) saved[key] = material[key];
      }
      if (writeMaterialTexture(material, slot, texture)) applied += 1;
    }
  }
  return applied;
}

/** 还原所有记过账的材质并清空记账。返回还原了几个材质。 */
export function restoreMaterialOverrides(ledger: MaterialOverrideLedger): number {
  let restored = 0;
  for (const [material, saved] of ledger) {
    for (const [key, value] of Object.entries(saved)) material[key] = value;
    restored += 1;
  }
  ledger.clear();
  return restored;
}
/**
 * 引擎侧：把一张覆盖贴图的 URL 变成 PlayCanvas `Texture`。
 * 用 `assets.loadFromUrl(url, "texture", cb)`——**回调的 err 才是权威**（只监听 error 事件会漏）。
 */
export function createOverrideTextureLoader(app: unknown): (url: string) => Promise<unknown> {
  return async (url: string) => {
    const pc = await import("playcanvas");
    const assets = (app as { assets: unknown }).assets as {
      loadFromUrl(url: string, type: string, callback: (err: unknown, asset: unknown) => void): void;
    };
    return new Promise((resolve, reject) => {
      assets.loadFromUrl(url, "texture", (err, asset) => {
        if (err) { reject(new Error(`texture load failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`)); return; }
        const resource = (asset as { resource?: unknown }).resource;
        if (!resource) { reject(new Error("the texture resource is empty")); return; }
        void pc;
        resolve(resource);
      });
    });
  };
}
