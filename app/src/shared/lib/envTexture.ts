import { useLoader } from "@react-three/fiber";
import { useEffect } from "react";
import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";

/**
 * HDR 环境贴图（天空盒）按扩展名选 loader。
 *
 * 必须分派，不能写死一个：天空盒生成落盘的是 Radiance **`.hdr`**（Blockade Labs
 * 导出类型 4 = hdri-hdr，见 chat/src/models/blockadelabs.ts），只有回退用的
 * `public/env/sky.exr` 才是 EXR——写死 EXRLoader 的话，用户真生成过天空盒之后
 * 视口背景球会解析失败（曾经的现象）。
 *
 * 分派规则与 drei `useEnvironment` 保持一致（exr → EXRLoader，其余 → RGBELoader），
 * 这样视口背景、IBL 与缩略图命中的是 `useLoader` 缓存里同一个条目，再由下方的
 * `useEnvironmentTexture` 跨 Canvas 引用计数，避免仍有使用者时提前释放。
 */
export function envLoaderFor(url: string): typeof EXRLoader | typeof RGBELoader {
  const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase();
  return ext === "exr" ? EXRLoader : RGBELoader;
}

interface TextureLease {
  texture: THREE.Texture;
  refs: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 同一个 URL 会同时被视口各窗格与天空盒缩略图使用。引用计数必须放在模块级，
 * 才能跨 Canvas 协调释放；最后一个使用者卸载后再延迟到下一个宏任务清理，
 * 让 React StrictMode 的 effect setup → cleanup → setup 能在纹理被 dispose 前
 * 重新认领它。
 */
const textureLeases = new Map<string, TextureLease>();

export function useEnvironmentTexture(url: string): THREE.Texture {
  const loader = envLoaderFor(url);
  const texture = useLoader(loader, url);

  // 与 drei useEnvironment 对齐；Environment 的 map 模式不会替我们设置这两项。
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;

  useEffect(() => {
    let lease = textureLeases.get(url);
    if (!lease || lease.texture !== texture) {
      lease = { texture, refs: 0 };
      textureLeases.set(url, lease);
    }
    if (lease.releaseTimer) {
      clearTimeout(lease.releaseTimer);
      lease.releaseTimer = undefined;
    }
    lease.refs += 1;

    return () => {
      if (!lease) return;
      lease.refs -= 1;
      if (lease.refs > 0) return;

      lease.releaseTimer = setTimeout(() => {
        if (!lease || lease.refs > 0 || textureLeases.get(url) !== lease) return;
        lease.texture.dispose();
        useLoader.clear(loader, url);
        textureLeases.delete(url);
      }, 0);
    };
  }, [loader, texture, url]);

  return texture;
}
