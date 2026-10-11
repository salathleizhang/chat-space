import { useEffect, useId, useRef, type ComponentPropsWithRef } from "react";
import { buildDisplacementMap, supportsLiquidGlass } from "./liquidGlass";

/** chrome 悬浮面板唯一出处,两档玻璃:
    - glass(默认):纯 CSS 毛玻璃,任意面板随便用;
    - liquid:SVG 位移滤镜的液态玻璃(边缘折射 + 色散),
      每个实例每帧都要重过滤镜,只给 1~2 个主角级 chrome
      (顶部导航、Agent Dock)用,禁止用在大面积或成排的面板上。
    widgets 里不允许再手写 glass/bg-surface/backdrop-blur 等表面类。 */
interface PanelProps extends ComponentPropsWithRef<"div"> {
  variant?: "glass" | "liquid";
}

const CHROME = "glass rounded-surface border border-line bg-surface";

export function Panel({ className = "", variant = "glass", ...props }: PanelProps) {
  if (variant === "liquid") {
    return <LiquidPanel className={className} {...props} />;
  }
  return <div className={`${CHROME} ${className}`} {...props} />;
}

/** liquid 档:基线仍是 glass 类(Safari/Firefox 与 JS 未跑时的降级),
    Chromium 上以内联 backdrop-filter 引用私有 SVG 滤镜覆盖。
    位移贴图按元素实际尺寸与圆角生成,resize 防抖重建——
    每帧重建会重新光栅化滤镜导致卡顿,过渡期旧贴图顶住。 */
function LiquidPanel({
  className = "",
  children,
  ...props
}: Omit<PanelProps, "variant">) {
  const filterId = `liquid-glass-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<SVGFEImageElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const map = mapRef.current;
    if (!host || !map || !supportsLiquidGlass()) return;

    const filter = `url(#${filterId}) blur(6px) saturate(150%)`;
    host.style.backdropFilter = filter;
    host.style.setProperty("-webkit-backdrop-filter", filter);

    const sync = () => {
      const rect = host.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0;
      map.setAttribute("href", buildDisplacementMap(rect.width, rect.height, radius));
    };
    let timer = 0;
    const schedule = () => {
      clearTimeout(timer);
      timer = window.setTimeout(sync, 140);
    };
    sync();
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [filterId]);

  return (
    <div ref={hostRef} className={`${CHROME} ${className}`} {...props}>
      <svg className="liquid-glass-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id={filterId} colorInterpolationFilters="sRGB">
            <feImage
              ref={mapRef}
              x="0"
              y="0"
              width="100%"
              height="100%"
              preserveAspectRatio="none"
              result="map"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              xChannelSelector="R"
              yChannelSelector="B"
              scale="-50"
              result="dispRed"
            />
            <feColorMatrix
              in="dispRed"
              type="matrix"
              values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"
              result="red"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              xChannelSelector="R"
              yChannelSelector="B"
              scale="-47"
              result="dispGreen"
            />
            <feColorMatrix
              in="dispGreen"
              type="matrix"
              values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0"
              result="green"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              xChannelSelector="R"
              yChannelSelector="B"
              scale="-44"
              result="dispBlue"
            />
            <feColorMatrix
              in="dispBlue"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0"
              result="blue"
            />
            <feBlend in="red" in2="green" mode="screen" result="rg" />
            <feBlend in="rg" in2="blue" mode="screen" result="output" />
            <feGaussianBlur in="output" stdDeviation="0.7" />
          </filter>
        </defs>
      </svg>
      {children}
    </div>
  );
}
