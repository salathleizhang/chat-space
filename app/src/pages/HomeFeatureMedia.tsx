import { useEffect, useRef, useState } from "react";
import type { HomeCopy } from "./homeCopy";
import type { ProductFeature } from "./homeShowcase";

function FeatureCover({ feature, copy, playing = false }: {
  feature: ProductFeature;
  copy: HomeCopy;
  playing?: boolean;
}) {
  return (
    <div className={`home-feature-cover home-feature-cover--${feature.cover}`} aria-hidden={playing}>
      <img
        className="home-cover-art"
        src={feature.coverImage ?? `/landing/${feature.cover}.png`}
        alt={copy.preview(feature.title)}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
      {feature.cover === "composer" && (
        <img className="home-cover-cursor" src="/landing/cursor.png" alt="" loading="lazy" draggable={false} />
      )}
    </div>
  );
}

/** Static artwork remains visible until the video actually starts playing. */
function FeatureVideo({ feature, copy }: { feature: ProductFeature; copy: HomeCopy }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<HTMLButtonElement>(null);
  const [requested, setRequested] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!requested) {
      video.pause();
      video.currentTime = 0;
      setPlaying(false);
      return;
    }

    let cancelled = false;
    const fail = () => {
      if (!cancelled) {
        setRequested(false);
        setPlaying(false);
      }
    };
    try {
      void video.play().catch(fail);
    } catch {
      fail();
    }

    const stop = () => setRequested(false);
    const visibilityChanged = () => { if (document.hidden) stop(); };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", visibilityChanged);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) stop();
    });
    if (hostRef.current) observer?.observe(hostRef.current);

    return () => {
      cancelled = true;
      video.pause();
      observer?.disconnect();
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [requested]);

  return (
    <button
      ref={hostRef}
      type="button"
      className="home-feature-media home-feature-demo"
      data-playing={playing}
      aria-label={requested ? copy.pauseDemo(feature.title) : copy.playDemo(feature.title)}
      aria-pressed={requested}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") setRequested(true); }}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") setRequested(false); }}
      onPointerCancel={() => setRequested(false)}
      onBlur={() => setRequested(false)}
      onClick={() => setRequested((current) => !current)}
    >
      <video
        ref={videoRef}
        className="home-feature-video object-contain"
        src={feature.video}
        aria-label={copy.demo(feature.title)}
        aria-hidden={!playing}
        loop
        muted
        playsInline
        preload="none"
        onPlaying={() => {
          if (requested) setPlaying(true);
          else videoRef.current?.pause();
        }}
        onPause={() => setPlaying(false)}
        onError={() => { setRequested(false); setPlaying(false); }}
      />
      <FeatureCover feature={feature} copy={copy} playing={playing} />
    </button>
  );
}

export function FeatureMedia({ feature, copy }: { feature: ProductFeature; copy: HomeCopy }) {
  return feature.video ? <FeatureVideo feature={feature} copy={copy} /> : (
    <div className="home-feature-media">
      <FeatureCover feature={feature} copy={copy} />
    </div>
  );
}
