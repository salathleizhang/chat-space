import { Canvas, useThree } from "@react-three/fiber";
import { Suspense, useEffect } from "react";
import * as THREE from "three";
import { useEnvironmentTexture } from "../../shared/lib/envTexture";
import { libraryUrl, type LibraryAsset } from "../../shared/lib/libraryApi";
import { ModelMesh } from "../Viewport/ModelMesh";

/**
 * 资产列表缩略图的离屏渲染器：服务端没有渲染能力，缩略图跟自检截图一样由
 * app 端画（见 ModelPreviewWindow 的 InspectionCapturer，取景与截图手法同源）。
 *
 * 全应用只有这一个隐藏 Canvas，队列一次喂一个资产进来（WebGL 上下文数量有上限，
 * 不能每个资产挂一个）。渲染参数全部写死——列表里几十张图必须是一套取景，
 * 任何"按资产自适应"的花样都会让那一列看上去参差不齐。
 *
 * 两类资产各有一种"化身"：模型直接渲模型，天空盒渲一个贴了环境贴图的球
 * （HDR 没法直接当图看）。除了取景方向与渲什么，其余（出图尺寸、等待时机、
 * 截图手法、落盘链路）两者完全共用。
 */

/** 模型：单一 ISO 视角，与自检图的 ISO 格同向 */
const MODEL_VIEW_DIR = new THREE.Vector3(1, 0.8, 1).normalize();
/** 天空盒：正对赤道平视，机位一抬高地平线就会在球面上拱起来，不像"站在这片天空里" */
const SKY_VIEW_DIR = new THREE.Vector3(0, 0, 1);
/** 包围球外扩，留出不贴边的余量 */
const FIT_MARGIN = 1.25;
/** 出图边长（正方形）。截图前显式 setSize，不依赖容器测量——见下方轮询注释 */
const THUMB_SIZE = 256;
/** 等模型进场景的轮询间隔 */
const POLL_MS = 120;
/** 模型迟迟进不了场景（加载失败/格式不支持）就放弃，不能把队列卡死 */
const LOAD_TIMEOUT_MS = 15_000;

export type ThumbnailCaptured = (asset: LibraryAsset, pngBase64: string | null) => void;

/**
 * 等模型真进了场景再截：Suspense 期间 Box3 是空的，轮询到有几何为止。
 *
 * 轮询用 setTimeout 而不是 requestAnimationFrame（自检截图那边用的是 rAF）：
 * 缩略图是后台任务，用户完全可能提交生成后就切走标签页。隐藏标签页里浏览器不跑
 * "更新渲染"这一步，rAF 与 ResizeObserver 双双冻结——后者意味着 R3F 量不到容器
 * 尺寸、连模型都不会挂进场景，这时是**画不出图**的。所以隐藏期间原地泊住（既不出图
 * 也不计入超时预算），标签页回到前台自然接着跑；用 setTimeout 是因为它只被节流、
 * 不像 rAF 那样彻底停摆，泊住期间仍有心跳能察觉到"可见了"。
 */
function ThumbnailCapturer({
  asset,
  onCaptured,
}: {
  asset: LibraryAsset;
  onCaptured: ThumbnailCaptured;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 只累计"可见时"等了多久：隐藏期间画不出图，不该算进超时预算 */
    let waited = 0;

    const capture = () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = setTimeout(capture, POLL_MS);
        return;
      }
      // 上下文被浏览器回收（后台标签页省显存的常见手段）时怎么画都是空白，直接放弃
      if (gl.getContext().isContextLost()) {
        onCaptured(asset, null);
        return;
      }
      const box = new THREE.Box3().setFromObject(scene);
      if (box.isEmpty() || !Number.isFinite(box.min.x)) {
        waited += POLL_MS;
        if (waited > LOAD_TIMEOUT_MS) onCaptured(asset, null);
        else timer = setTimeout(capture, POLL_MS);
        return;
      }

      // 显式定尺寸，不吃容器测量：离屏容器的 ResizeObserver 在隐藏标签页里不回调，
      // 靠测量的话画布会停在 300×150 的默认尺寸上，出图既不是正方形也不是 256
      gl.setSize(THUMB_SIZE, THUMB_SIZE, false);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const persp = camera as THREE.PerspectiveCamera;
      // 退化包围球（单点几何）兜一个下限，否则 fitDistance 为 0、相机落在模型内部
      const radius = Math.max(sphere.radius, 1e-3);
      const fitDistance = (radius / Math.tan((persp.fov * Math.PI) / 360)) * FIT_MARGIN;
      const viewDir = asset.kind === "skybox" ? SKY_VIEW_DIR : MODEL_VIEW_DIR;
      camera.position.copy(sphere.center).addScaledVector(viewDir, fitDistance);
      camera.lookAt(sphere.center);
      persp.aspect = 1;
      persp.updateProjectionMatrix();
      gl.render(scene, camera);

      const dataUrl = gl.domElement.toDataURL("image/png");
      onCaptured(asset, dataUrl.slice(dataUrl.indexOf(",") + 1));
    };

    timer = setTimeout(capture, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [asset, gl, scene, camera, onCaptured]);

  return null;
}

/**
 * 天空盒的"资产化身"：一个贴了环境贴图的球（不是镜面反射球——40px 的方图里
 * 镜面会把整张全景压进中心一小块，几个天空盒长得都一样；直接贴图才看得出天气）。
 *
 * `toneMapped={false}` 与视口的 `SkyBackdrop` 一致：缩略图要和视口背景是同一个气质。
 * 贴图经 `useEnvironmentTexture` 加载，与视口共享同一个缓存条目/同一个 THREE.Texture，
 * 且参与同一份跨 Canvas 引用计数——缩略图卸载不会提前释放视口仍在使用的纹理。队列只对
 * 当前生效的天空盒排队（见 useThumbnailQueue），所以不会额外常驻一份 HDR 像素数据。
 */
function SkyboxSphere({ url }: { url: string }) {
  const texture = useEnvironmentTexture(url);
  return (
    <mesh>
      <sphereGeometry args={[1, 64, 32]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/**
 * 隐藏的离屏画布。挂在视口外（不是 display:none——那样 canvas 尺寸会塌成 0），
 * 由调用方 portal 到 body，不参与列表面板的布局。
 */
export function ThumbnailRenderer({
  asset,
  onCaptured,
}: {
  asset: LibraryAsset;
  onCaptured: ThumbnailCaptured;
}) {
  // 同一资产换代时 id 不变，必须让旧 Suspense 子树立即卸载；否则新模型加载期间
  // React 可能保留已显示的旧模型，Capturer 会把旧版本误当成新版本截图落盘。
  const sourceKey = asset.modelPath ?? asset.hdrPath ?? asset.id;
  return (
    <div aria-hidden className="pointer-events-none fixed top-0 -left-[9999px] h-64 w-64">
      <Canvas
        dpr={1}
        frameloop="demand"
        camera={{ fov: 45, position: [1.6, 1.2, 1.6] }}
        gl={{ preserveDrawingBuffer: true, alpha: true }}
      >
        {/* 灯光与预览小窗一致，保证缩略图和双击放大后看到的是同一个模型气质 */}
        <ambientLight intensity={0.7} />
        <directionalLight position={[4, 6, 4]} intensity={1.4} />
        <directionalLight position={[-4, 2, -3]} intensity={0.5} />
        {/* key 到资产：换资产时旧模型立刻卸载，Box3 重新变空，轮询等新模型进场。
            天空盒同理——贴图加载期间 Suspense 挂起，球不在场景里，等待机制原样成立 */}
        <Suspense key={sourceKey} fallback={null}>
          {asset.kind === "skybox" && asset.hdrPath ? (
            <SkyboxSphere url={libraryUrl(asset.hdrPath)} />
          ) : (
            <ModelMesh asset={asset} />
          )}
        </Suspense>
        <ThumbnailCapturer asset={asset} onCaptured={onCaptured} />
      </Canvas>
    </div>
  );
}
