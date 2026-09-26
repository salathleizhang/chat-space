import { extend, useThree } from "@react-three/fiber";
import { PackedSplats, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResettableErrorBoundary } from "../../shared/lib/ResettableErrorBoundary";
import type { WorldSemantics } from "../../shared/lib/libraryApi";
import { worldTransform } from "./worldTransform";

/**
 * 已知边界：`@sparkjsdev/spark` 把自己的 three.js 内嵌进了 `dist/spark.module.js`
 * （约 5.1MB），所以本懒加载 chunk 里自带一份 three，与 vite `manualChunks` 抽出的
 * app 共享 three chunk 是两份实例——查看泼溅时 `window.__THREE__` 会触发
 * “Multiple instances of Three.js” 的 console.warn。这是上游打包行为，Vite 层无法去重；
 * spark 的 three 自包含（不参与 R3F 场景对象互操作），实际风险低，留作已知项。
 */
const SparkRendererEl = extend(SparkRenderer);
const SplatMeshEl = extend(SplatMesh);

interface SharedSplatResource {
  splats: PackedSplats;
  initialized: Promise<void>;
  ready: boolean;
  error?: Error;
  refs: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Drei View 的每个 portal 都需要自己的 SplatMesh/SparkRenderer（相机和排序不同），但解码后的
 * PackedSplats 与它在同一个 WebGLRenderer 上的纹理可以共享。按 URL 缓存后，四视图只 fetch/
 * decode/upload 一次；引用计数负责在最后一个窗格卸载时释放。
 */
const sharedSplats = new Map<string, SharedSplatResource>();

function splatError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createSharedSplats(url: string): SharedSplatResource {
  const splats = new PackedSplats({ url });
  const resource: SharedSplatResource = {
    splats,
    ready: false,
    refs: 0,
    initialized: Promise.resolve(),
  };
  resource.initialized = splats.initialized
    .then(() => {
      resource.ready = true;
    })
    .catch((error: unknown) => {
      resource.error = splatError(error);
      throw resource.error;
    });
  sharedSplats.set(url, resource);
  return resource;
}

function readSharedSplats(url: string): SharedSplatResource {
  const resource = sharedSplats.get(url) ?? createSharedSplats(url);
  if (resource.error) throw resource.error;
  if (!resource.ready) throw resource.initialized;
  return resource;
}

function clearSharedSplats(url: string) {
  const resource = sharedSplats.get(url);
  if (!resource || resource.refs > 0) return;
  if (resource.releaseTimer) clearTimeout(resource.releaseTimer);
  resource.splats.dispose();
  sharedSplats.delete(url);
}

function useSharedSplats(url: string): PackedSplats {
  const resource = readSharedSplats(url);
  useEffect(() => {
    if (resource.releaseTimer) {
      clearTimeout(resource.releaseTimer);
      resource.releaseTimer = undefined;
    }
    resource.refs += 1;
    return () => {
      resource.refs -= 1;
      if (resource.refs > 0) return;
      // 给 StrictMode 的模拟卸载/重挂一个宏任务认领窗口。
      resource.releaseTimer = setTimeout(() => {
        if (resource.refs > 0 || sharedSplats.get(url) !== resource) return;
        resource.splats.dispose();
        sharedSplats.delete(url);
      }, 0);
    };
  }, [resource, url]);
  return resource.splats;
}

function SharedSplatScene({ url, semantics }: { url: string; semantics: WorldSemantics }) {
  const renderer = useThree((state) => state.gl);
  const packedSplats = useSharedSplats(url);
  const sparkArgs = useMemo(() => ({ renderer }), [renderer]);
  const splatArgs = useMemo(() => ({ packedSplats }), [packedSplats]);
  const transform = useMemo(() => worldTransform(semantics), [semantics]);
  return (
    <SparkRendererEl args={[sparkArgs]}>
      {/*
        World Labs 的 +Y 朝下，不套这层变换整个世界就是倒的。参数来自世界响应的
        semantics_metadata；collider 那边用的是同一份（见 worldTransform）。
      */}
      <group position={transform.position} rotation={transform.rotation} scale={transform.scale}>
        {/* PackedSplats 归模块级租约所有；窗格卸载不能让单个 SplatMesh dispose 它。 */}
        <SplatMeshEl args={[splatArgs]} dispose={null} />
      </group>
    </SparkRendererEl>
  );
}

/**
 * 高斯泼溅（spz）渲染。资源 promise 显式抛给 Suspense，网络/解码异常显式抛给错误边界；
 * 首次失败清理共享拒绝缓存并重试一次，永久错误保持局部隔离而不会形成未处理 Promise。
 */
export default function SplatModel({
  url,
  semantics,
}: {
  url: string;
  semantics: WorldSemantics;
}) {
  const [attempt, setAttempt] = useState(0);
  const retriedRef = useRef(false);
  const handleError = useCallback(() => {
    if (retriedRef.current) {
      // 永久失败的 promise 从未 commit，不会进入引用计数 cleanup；这里主动释放拒绝条目。
      clearSharedSplats(url);
      return;
    }
    retriedRef.current = true;
    clearSharedSplats(url);
    setAttempt(1);
  }, [url]);

  return (
    <ResettableErrorBoundary
      resetKey={`${url}|${attempt}`}
      fallback={null}
      onError={handleError}
    >
      <Suspense fallback={null}>
        <SharedSplatScene url={url} semantics={semantics} />
      </Suspense>
    </ResettableErrorBoundary>
  );
}
