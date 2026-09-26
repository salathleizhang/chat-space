import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import {
  libraryUrl,
  type AssetMaterial,
  type MaterialTextureSlot,
} from "../../shared/lib/libraryApi";
import { isDefaultMaterial, normalizeMaterial } from "../../shared/lib/materialOverrides";

/**
 * 把右侧栏的贴图替换真正套到模型上。覆盖只做一件事：**克隆原材质、只改用户动过的槽位**。
 *
 * 三条纪律：
 * ① **只改克隆体**。`ClonedAssembly` 用 `SkeletonUtils.clone` 克隆场景图，几何体与材质仍是
 *    与 loader 缓存共享的同一份引用（悬浮卡的贴图预览、预览小窗、缩略图都读那份原件）。
 *    直接改材质属性会污染整个应用的其它读取方，所以这里一律换成**新建的**材质实例。
 * ② **克隆而不是重建**。不 new MeshStandardMaterial 再搬运属性：供应商文件里的材质类
 *    （glTF 的 clearcoat/transmission、OBJ 的 specular、unlit 的 basic）与全部参数都该原样
 *    保留，用户换的只是某几个通道的图。`Material.clone()` 正好是这个语义。
 * ③ **加载中不套用**。贴图是异步的，等不到就先让原材质继续渲染——把模型藏起来等一张图，
 *    比多显示一帧旧材质糟得多。
 */

/**
 * 原始贴图按 URL 缓存：同一张图被两个资产/两个通道用到时只解码一次。
 * 缓存常驻不回收是有意的——它按 URL 去重，条目数上界就是工程里被指定过的图片数；
 * 每次套用另外克隆一份（见 `prepareTexture`）并按次释放，所以反复换图不会累积。
 */
const rawTextureCache = new Map<string, Promise<THREE.Texture>>();
const textureLoader = new THREE.TextureLoader();

function loadRawTexture(path: string): Promise<THREE.Texture> {
  const url = libraryUrl(path);
  let pending = rawTextureCache.get(url);
  if (!pending) {
    pending = textureLoader.loadAsync(url).catch((error: unknown) => {
      // 失败不进缓存，否则一次网络抖动会让这个通道永远换不回来
      rawTextureCache.delete(url);
      throw error;
    });
    rawTextureCache.set(url, pending);
  }
  return pending;
}

/**
 * 新贴图要跟模型自带的贴图用同一套 UV 约定。glTF 规定 `flipY = false`，OBJ/FBX 走
 * TextureLoader 默认的 `true`；按扩展名猜会在"同一个资产里混着两种来源"时翻车，
 * 所以直接从模型自己的贴图上抄一个——一个模型的 UV 约定只有一种。
 */
function inferFlipY(root: THREE.Object3D): boolean {
  let flipY: boolean | undefined;
  root.traverse((node) => {
    if (flipY !== undefined) return;
    const material = (node as { material?: THREE.Material | THREE.Material[] }).material;
    if (!material) return;
    for (const mat of Array.isArray(material) ? material : [material]) {
      for (const slot of SLOT_PROBE_ORDER) {
        const texture = readSlot(mat, slot);
        if (texture) {
          flipY = texture.flipY;
          return;
        }
      }
    }
  });
  return flipY ?? false;
}

/** 推断 UV 约定时按这个顺序找第一张能看的贴图；与可覆盖通道同表 */
const SLOT_PROBE_ORDER: readonly MaterialTextureSlot[] = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
];

/** 需要按 sRGB 采样的通道；其余（法线/粗糙度/AO…）是线性数据，标错会让明暗整片偏掉 */
const SRGB_SLOTS: ReadonlySet<MaterialTextureSlot> = new Set(["map", "emissiveMap"]);

/**
 * 每次套用都为每个通道克隆一份，而不是复用缓存里的原件：`colorSpace`/`flipY`/`wrapS`
 * 是贴图自身的属性，两个通道共用同一张图却需要不同的色彩空间时，改原件必然互相打架。
 * 克隆出来的这份由 `restoreOverride` 负责 dispose，不会随用户反复换图无限累积。
 */
function prepareTexture(
  base: THREE.Texture,
  slot: MaterialTextureSlot,
  flipY: boolean,
): THREE.Texture {
  const texture = base.clone();
  texture.colorSpace = SRGB_SLOTS.has(slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.flipY = flipY;
  // 换上去的图多是 AI 编辑/生成的方形参考图，平铺语义比默认的 clamp 更符合预期
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function readSlot(material: THREE.Material, slot: string): THREE.Texture | null {
  const value = (material as unknown as Record<string, unknown>)[slot] as
    | THREE.Texture
    | null
    | undefined;
  return value?.isTexture ? value : null;
}

/**
 * 直接赋值而不是走 `Material.setValues`：通道列表已经按真实材质收窄过（见
 * `collectSupportedSlots`），但 scene.json 里可能留着旧版本或 agent 写下的、当前材质不认的
 * 槽位——`setValues` 会为每个未知键打一条警告，而我们要的语义恰恰是"不认就静默忽略"。
 */
function writeSlot(material: THREE.Material, slot: string, texture: THREE.Texture): void {
  (material as unknown as Record<string, unknown>)[slot] = texture;
}

/**
 * 克隆原材质并补上被替换的通道。导出是为了单测：贴图加载是异步的、在 happy-dom 里
 * `<img>` 永远不回调，所以可测的是这一层纯逻辑，而不是外面那个 hook。
 */
export function createOverrideMaterial(
  source: THREE.Material,
  textures: ReadonlyMap<MaterialTextureSlot, THREE.Texture>,
): THREE.Material {
  const target = source.clone();
  for (const [slot, texture] of textures) writeSlot(target, slot, texture);
  return target;
}

interface AppliedOverride {
  meshes: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
}

/**
 * 把覆盖套到整棵克隆体上，并返回还原所需的一切。导出是为了单测：
 * 它能被直接喂一张手工构造的贴图表，不需要走网络。
 */
export function applyOverride(
  root: THREE.Object3D,
  rawTextures: ReadonlyMap<MaterialTextureSlot, THREE.Texture>,
): AppliedOverride {
  const flipY = inferFlipY(root);
  const textures = new Map<MaterialTextureSlot, THREE.Texture>();
  for (const [slot, raw] of rawTextures) {
    textures.set(slot, prepareTexture(raw, slot, flipY));
  }

  const applied: AppliedOverride = { meshes: [], materials: [], textures: [...textures.values()] };
  /** 同一个原材质可能被多个 mesh 共用，按原材质去重，免得造出一堆等价实例 */
  const bySource = new Map<THREE.Material, THREE.Material>();
  const swap = (source: THREE.Material): THREE.Material => {
    let next = bySource.get(source);
    if (!next) {
      next = createOverrideMaterial(source, textures);
      bySource.set(source, next);
      applied.materials.push(next);
    }
    return next;
  };

  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    // 只碰网格：高亮包围盒是 LineSegments，还有 Sprite/Points 都不该被换材质
    if (!mesh.isMesh || !mesh.material) return;
    const original = mesh.material;
    applied.meshes.push({ mesh, original });
    mesh.material = Array.isArray(original) ? original.map(swap) : swap(original);
  });

  return applied;
}

/** 还原成原材质并释放自己造的那批实例；原件归 three 的 loader 缓存管，不碰 */
export function restoreOverride(applied: AppliedOverride): void {
  for (const { mesh, original } of applied.meshes) mesh.material = original;
  for (const material of applied.materials) material.dispose();
  for (const texture of applied.textures) texture.dispose();
}

/** 没有贴图替换时的共用空表：引用稳定，避免每次渲染都让套用副作用重跑一遍 */
const NO_TEXTURES: Map<MaterialTextureSlot, THREE.Texture> = new Map();

/**
 * 异步解析被替换的通道。返回 `null` 表示"还在加载"——调用方据此继续显示原材质。
 * 加载失败退化成空表：那个通道沿用模型自带贴图，而不是整份覆盖失败。
 */
function useOverrideTextures(
  spec: AssetMaterial | null,
): Map<MaterialTextureSlot, THREE.Texture> | null {
  const entries = useMemo(() => {
    const pairs: [MaterialTextureSlot, string][] = [];
    for (const [slot, path] of Object.entries(spec?.textures ?? {})) {
      if (typeof path === "string" && path.length > 0) {
        pairs.push([slot as MaterialTextureSlot, path]);
      }
    }
    return pairs;
  }, [spec]);
  const key = entries.map(([slot, path]) => `${slot}=${path}`).join("|");

  const [resolved, setResolved] = useState<{
    key: string;
    textures: Map<MaterialTextureSlot, THREE.Texture>;
  }>(() => ({ key: "", textures: NO_TEXTURES }));

  useEffect(() => {
    if (entries.length === 0) {
      // 已经就是这个 key 时返回原状态，别为了一个空表触发一轮重渲染 + 重套材质
      setResolved((prev) =>
        prev.key === key && prev.textures === NO_TEXTURES ? prev : { key, textures: NO_TEXTURES },
      );
      return;
    }
    let cancelled = false;
    void Promise.all(
      entries.map(async ([slot, path]) => [slot, await loadRawTexture(path)] as const),
    )
      .then((pairs) => {
        if (!cancelled) setResolved({ key, textures: new Map(pairs) });
      })
      .catch(() => {
        if (!cancelled) setResolved({ key, textures: NO_TEXTURES });
      });
    return () => {
      cancelled = true;
    };
    // entries 的内容完全由 key 决定，依赖 key 就够，不需要每次渲染重建的数组引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return resolved.key === key ? resolved.textures : null;
}

/**
 * 把贴图替换套到已克隆的模型上。没被改过材质的资产（绝大多数）整段跳过，不走遍历。
 *
 * `invalidate` 是**必填**的：本应用所有 Canvas 都跑 `frameloop="demand"`，直接改
 * `mesh.material` 只是改了内存里的对象，没有任何东西会因此要一帧；不显式要帧的话，
 * 用户换了贴图会看到画面纹丝不动，直到下次转视角才突然变。调用方传 R3F 的
 * `invalidate`（见 ModelMesh 的 ClonedAssembly）；做成参数而不是在 hook 里调 `useThree`，
 * 是为了让这个模块不依赖 Canvas 上下文，可以直接用普通 three 对象单测。
 */
export function useMaterialOverride(
  root: THREE.Object3D | null,
  material: AssetMaterial | undefined,
  invalidate: () => void,
): void {
  const spec = useMemo(
    () => (isDefaultMaterial(material) ? null : normalizeMaterial(material)),
    [material],
  );
  const textures = useOverrideTextures(spec);

  useEffect(() => {
    if (!root || !spec || textures === null) return;
    const applied = applyOverride(root, textures);
    invalidate();
    return () => {
      restoreOverride(applied);
      // 换回原贴图同样是一次静默的内存改动，也要补一帧
      invalidate();
    };
  }, [root, spec, textures, invalidate]);
}
