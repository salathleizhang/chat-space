/**
 * Dev-only synthetic Gaussian Splat probe fixture — a PROBE VALIDATION TOOL,
 * not a measurement of any real project.
 *
 * Purpose: validate that the GPU probe can actually see GPU work, with controls
 * that scale. Measured in a visible Chrome 154 window: Three's render-pass
 * timestamps gave 0.26 ms at 1 quad and 7.60 ms at 800 quads, then 0.26 ms for
 * a 200k-splat cloud and 0.26 ms for a 1.92M-splat cloud. Those synthetic
 * numbers are NOT representative of a real World Labs world (the synthetic
 * cloud uses small, sparse, near-zero-SH splats), so do not quote them as
 * product performance. For real numbers use the protocol in
 * WEBGPU_PROBE_PROTOCOL.md against a real project.
 *
 * Known limitation: this fixture cannot isolate Gaussian-splat sort cost. The
 * real sort is a TNS compute chain inside GSL with no separable timing boundary.
 *
 * Builds an in-memory `Splats` source (the same 2x16-byte encoded records the
 * loaders produce) so the per-view sorting/projection cost can be measured
 * WITHOUT a backend project, a World Labs account, or an SPZ asset.
 *
 * Encoded record layout, per GSL's `decodeSplat`:
 *   splatA[i*4+0..2] = float32 center xyz
 *   splatA[i*4+3]    = opacity = clamp(round(255 * 1/sqrt(1+exp(-v))), 0, 255)
 *   splatB[i*4+0]    = half color.r | half color.g << 16
 *   splatB[i*4+1]    = half color.b | half exp(scale.y) << 16
 *   splatB[i*4+2]    = half exp(scale.z)... (see decodeSplat: scales from half exponents)
 *   splatB[i*4+3]    = packed octahedral quaternion
 *
 * Requires the page to be loaded with `?gpuTimestamps=1` so
 * `NativeWebGPURenderer.trackTimestamp` is on before the backend is built.
 */
import * as THREE from "three";
import { GaussianSplatRenderer, Splats, SplatMesh } from "gaussian-splat-lite";
import { NativeWebGPURenderer } from "../../shared/rendering/webgpu";
import { GpuFrameSampler } from "../../shared/rendering/gpuProbe";

/** Opacity quantization inverse: logit(p) with p = round(255 * sigmoid(v)). */
function encodeOpacity(alpha: number): number {
  const clamped = Math.min(1, Math.max(0, alpha));
  const quantized = Math.round(255 * clamped) / 255;
  const p = Math.min(1 - 1e-6, Math.max(1e-6, quantized));
  const logit = Math.log(p / (1 - p));
  return Math.round(255 * (1 / Math.sqrt(1 + Math.exp(-logit)))) & 0xff;
}

function halfToFloatBits(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

/** Deterministic pseudo-random so runs are comparable. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface SyntheticShape {
  /** Cloud radius in metres. A trained world spans tens of metres, not a few. */
  extent?: number;
  /** Gaussian radius in metres. Trained scenes use visibly larger splats. */
  splatRadius?: number;
  /** Flatten into a ground-plane-like slab, as walkable captures are. */
  groundBias?: number;
}

/**
 * Builds a reproducible cloud; a real SPZ world is ~1.9M points.
 *
 * `extent` and `splatRadius` matter a lot: a small-extent cloud of tiny splats
 * fits in texture cache and under-reports rasterisation cost, which is why the
 * default fixture is NOT a valid stand-in for a real world.
 */
export function buildSyntheticSplats(count: number, seed = 12345, shape: SyntheticShape = {}): Splats {
  const extent = shape.extent ?? 6;
  const splatRadius = shape.splatRadius ?? 0.02;
  const groundBias = shape.groundBias ?? 0.6;
  const random = rng(seed);
  const splatA = new Uint32Array(count * 4);
  const splatB = new Uint32Array(count * 4);
  const sortCenters = new Float32Array(count * 3);
  const sourceIds = new Uint32Array(count);
  // createDecodedState requires blocks of SPLAT_BOUNDS_BLOCK_SIZE (256) records.
  const spatialBounds = new Float32Array(Math.ceil(count / 256) * 6);
  for (let index = 0; index < count; index += 1) sourceIds[index] = index;
  const view = new DataView(new ArrayBuffer(4));
  const put = (target: Uint32Array, index: number, value: number) => {
    view.setFloat32(0, value, true);
    target[index] = view.getUint32(0, true);
  };
  for (let index = 0; index < count; index += 1) {
    const i4 = index * 4;
    const radius = extent * Math.cbrt(random());
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.cos(phi) * groundBias;
    const z = radius * Math.sin(phi) * Math.sin(theta);
    put(splatA, i4, x);
    put(splatA, i4 + 1, y);
    put(splatA, i4 + 2, z);
    sortCenters[index * 3] = x;
    sortCenters[index * 3 + 1] = y;
    sortCenters[index * 3 + 2] = z;
    splatA[i4 + 3] = encodeOpacity(0.35 + random() * 0.5);
    // Colour: mid greys/earth tones so the cloud is visually plausible.
    const r = 0.3 + random() * 0.5, g = 0.25 + random() * 0.5, b = 0.2 + random() * 0.5;
    const rh = halfToFloatBits(r) >>> 0, gh = halfToFloatBits(g) >>> 0;
    const sy = splatRadius * (0.8 + random() * 0.4);
    const sz = splatRadius * (0.8 + random() * 0.4);
    const bh = halfToFloatBits(b) >>> 0, syh = halfToFloatBits(sy) >>> 0;
    const szh = halfToFloatBits(sz) >>> 0;
    splatB[i4] = (rh & 0xffff) | ((gh & 0xffff) << 16);
    splatB[i4 + 1] = (bh & 0xffff) | ((syh & 0xffff) << 16);
    splatB[i4 + 2] = (szh & 0xffff);
    splatB[i4 + 3] = 0; // identity-ish packed quaternion
  }
  const splats = new Splats();
  splats.initializeDecoded({
    numSplats: count,
    splatArrays: [splatA, splatB],
    sortCenters,
    sourceIds,
    centerOnlyBoundingBox: new Float32Array([-extent * 1.4, -extent * 1.4, -extent * 1.4, extent * 1.4, extent * 1.4, extent * 1.4]),
    boundingBox: new Float32Array([-extent * 1.4, -extent * 1.4, -extent * 1.4, extent * 1.4, extent * 1.4, extent * 1.4]),
    spatialBounds,
    extra: {},
  });
  return splats;
}

export interface SyntheticProbeOptions {
  /** Splat count; the recorded 1.92M world is the realistic stress case. */
  count?: number;
  /** How many simultaneous GSL view renderers, matching the 1/2/4 layouts. */
  views?: number;
  /** Rotate the camera to force the per-frame re-sort. */
  motion?: boolean;
  durationMs?: number;
  warmupMs?: number;
  width?: number;
  height?: number;
  /** Use Three's adaptive SplatMesh path instead of a raw Splats source. */
  viaSplatMesh?: boolean;
}

export async function runSyntheticSplatProbe(options: SyntheticProbeOptions = {}) {
  const count = options.count ?? 1_920_000;
  const viewCount = options.views ?? 1;
  const durationMs = options.durationMs ?? 8_000;
  const warmupMs = options.warmupMs ?? 2_000;
  const width = options.width ?? 1280;
  const height = options.height ?? 720;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);

  const renderer = new NativeWebGPURenderer(canvas);
  const errors: string[] = [];
  renderer.onError = (error) => errors.push(String((error as { message?: string })?.message ?? error));
  await renderer.init();
  renderer.setSize(width, height, false);

  const backend = renderer.backend as unknown as { trackTimestamp?: boolean; device?: { limits?: object } };
  const trackTimestamp = backend.trackTimestamp === true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202028);
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 500);

  const splats = buildSyntheticSplats(count);
  const created: GaussianSplatRenderer[] = [];
  let mesh: SplatMesh | null = null;
  if (options.viaSplatMesh) {
    mesh = new SplatMesh({ splats, editable: false, raycastable: false });
    mesh.name = "synthetic-splats";
    scene.add(mesh);
  } else {
    for (let index = 0; index < viewCount; index += 1) {
      const view = new GaussianSplatRenderer({
        renderer: renderer as never,
        renderDepth: false,
        autoStochastic: false,
        stochastic: false,
      });
      created.push(view);
      scene.add(view);
    }
  }

  // navigator.gpu is not in the ambient DOM lib for this TS target.
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string } } | null> } }).gpu;
  const adapter = await gpu?.requestAdapter();
  const adapterInfo = adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture } : null;

  const sampler = new GpuFrameSampler(renderer as never, `synthetic-${count}-${viewCount}v`, scene);
  const radius = 9;
  const started = performance.now();
  let last = started;
  let raf = 0;
  let finished = false;

  const finish = (reason: string | null) => {
    if (finished) return sampler.result;
    finished = true;
    cancelAnimationFrame(raf);
    const result = sampler.stop(reason);
    return {
      ...result,
      fixture: { count, viewCount, trackTimestamp, adapter: adapterInfo, errors,
        canvas: `${width}x${height}`, viaSplatMesh: Boolean(options.viaSplatMesh) },
    };
  };

  const frame = (now: number) => {
    if (finished) return;
    const elapsed = now - started;
    const interval = now - last;
    const sampling = elapsed >= warmupMs && last - started >= warmupMs;
    last = now;

    const angle = options.motion ? elapsed / 1000 * 0.35 : 0.4;
    camera.position.set(Math.cos(angle) * radius, 3.2, Math.sin(angle) * radius);
    camera.lookAt(0, 0, 0);

    for (const view of created) view.visible = true;
    const renderStart = performance.now();
    renderer.render(scene, camera);
    const submitMs = performance.now() - renderStart;

    if (sampling) void sampler.sample(interval, submitMs);
    if (elapsed >= warmupMs + durationMs) { finish(null); return; }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  // The scene walks its own update path; poll until it settles or the probe ends.
  await new Promise<void>((resolve) => {
    const check = () => {
      if (finished) { resolve(); return; }
      setTimeout(check, 50);
    };
    check();
  });
  const result = finish(null);
  for (const view of created) { scene.remove(view); view.dispose?.(); }
  if (mesh) { scene.remove(mesh); mesh.dispose(); }
  splats.dispose();
  canvas.remove();
  await renderer.dispose();
  return result;
}
