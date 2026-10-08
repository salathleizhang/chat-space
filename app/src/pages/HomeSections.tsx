import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import type { ProductFeature, ShowcaseWorld } from "./homeShowcase";

/**
 * 首页搜索框以下的两段营销版式。
 *
 * 拆成独立文件而不是塞进 `HomePage.tsx`：页面本体只负责「创建项目」这条交互，
 * 这两段是纯展示（数据由 `homeShowcase.ts` 给、点击由调用方接），放一起会让
 * 首页那个已经不小的组件再翻一倍。
 */

/**
 * 世界卡：整张卡就是一张缩略图，不再有正文——卡面上只留世界名、尺度标签和
 * 一个「打开」箭头，介绍文案没有信息量还占掉一半卡高。
 *
 * 圆角用 `rounded-surface`：和搜索框、项目页的文件夹卡同一套 token，
 * 首页从上到下才是一个系统（`index.css` 的圆角层级：surface/inset/control/media）。
 */
function WorldCard({ world, onOpen }: { world: ShowcaseWorld; onOpen: (world: ShowcaseWorld) => void }) {
  /** 没有项目 slug = 占位项，点击只能回到项目列表 */
  const isPlaceholder = !world.projectSlug;
  return (
    <button
      type="button"
      className="group relative block w-full overflow-hidden rounded-surface border border-project-hub-ink-faint/25 bg-project-hub-ink-strong text-left transition-[border-color,box-shadow,translate] duration-200 ease-spring hover:border-project-hub-ink-faint/60 hover:shadow-[0_18px_36px_-22px_rgb(22_22_24/0.5)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-project-hub-ink-strong motion-safe:hover:-translate-y-0.5"
      onClick={() => onOpen(world)}
      aria-label={isPlaceholder ? `Browse projects (${world.name} is a placeholder world)` : `Enter world ${world.name}`}
    >
      <img
        src={world.thumbnail}
        alt={`${world.name} preview`}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="aspect-[3/2] w-full object-cover transition-transform duration-500 ease-spring group-hover:scale-[1.05]"
      />
      {/* 底部渐变只为压住白字，不参与语义 */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/75 via-black/25 to-transparent"
      />
      {/* 标签走右上角而不是跟名字并排：4 列时卡片只有 ~230px，并排会把世界名挤到截断 */}
      {/* 内缩 16px 而不是 12px：35px 的圆角下，12px 的标签会贴着圆弧 */}
      <span className="absolute top-4 right-4 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
        {world.setting}
      </span>
      {isPlaceholder && (
        <span className="absolute top-4 left-4 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white/90">
          Placeholder
        </span>
      )}
      <span className="absolute bottom-4 left-4 block pr-10 truncate text-sm font-semibold text-white drop-shadow-sm">
        {world.name}
      </span>
      {/* 「打得开」这件事现在只由这个箭头表达，不再写一行字 */}
      <span
        aria-hidden="true"
        className="absolute right-4 bottom-4 flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur-sm transition-colors duration-200 group-hover:bg-white/35"
      >
        <ArrowUpRightIcon size={13} weight="bold" />
      </span>
    </button>
  );
}

/** 搜索框下面的 4 个世界缩略图 */
export function WorldShowcase({
  worlds,
  onOpenWorld,
  onIntent,
}: {
  worlds: ShowcaseWorld[];
  onOpenWorld: (world: ShowcaseWorld) => void;
  /** 鼠标移入 / 键盘聚焦时提前拉起工作台 chunk，点击时命中 import() 的模块缓存 */
  onIntent?: () => void;
}) {
  return (
    <section className="mt-16" aria-labelledby="worlds-title">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="worlds-title" className="text-sm font-medium text-project-hub-ink-strong">
          Featured worlds
        </h2>
        <span className="text-xs text-project-hub-ink-subtle">
          Generated environments — step inside and build in them
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {worlds.map((world) => (
          <li key={world.id} onMouseEnter={onIntent} onFocus={onIntent}>
            <WorldCard world={world} onOpen={onOpenWorld} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 特性的媒体块。
 *
 * 有录屏时播放静音循环视频，首帧预览与录屏同源；视频保留完整画面，避免裁掉字幕。
 * 尚无录屏的特性继续显示静态预览。
 */
function FeatureMedia({ feature }: { feature: ProductFeature }) {
  return (
    <div className="relative overflow-hidden rounded-surface border border-project-hub-ink-faint/20 bg-project-hub-ink-strong shadow-[0_24px_60px_-32px_rgb(22_22_24/0.55)]">
      {feature.video ? (
        <video
          className="aspect-video w-full object-contain"
          src={feature.video}
          poster={feature.image}
          aria-label={`${feature.title} demo`}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
        />
      ) : (
        <img
          src={feature.image}
          alt={`${feature.title} preview`}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="aspect-16/10 w-full object-cover motion-safe:animate-media-drift"
        />
      )}
    </div>
  );
}

/** 左图右文 / 左文右图交替的特性段落 */
export function FeatureShowcase({ features }: { features: ProductFeature[] }) {
  return (
    <section className="mt-24" aria-labelledby="features-title">
      <div className="mb-10 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="features-title" className="text-sm font-medium text-project-hub-ink-strong">
          What you can do
        </h2>
        <span className="text-xs text-project-hub-ink-subtle">
          {features.length} capabilities, one workspace
        </span>
      </div>

      <div className="flex flex-col gap-16 lg:gap-24">
        {features.map((feature, index) => {
          /** 偶数行图在左，奇数行图在右 */
          const mediaFirst = index % 2 === 0;
          return (
            <article
              key={feature.id}
              aria-labelledby={`feature-${feature.id}`}
              className="grid grid-cols-1 items-center gap-7 lg:grid-cols-2 lg:gap-14"
            >
              <div className={mediaFirst ? "" : "lg:order-2"}>
                <FeatureMedia feature={feature} />
              </div>
              <div className={mediaFirst ? "" : "lg:order-1"}>
                <span className="text-[11px] font-medium tracking-[0.14em] text-project-hub-ink-faint tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3
                  id={`feature-${feature.id}`}
                  className="mt-2 text-xl font-semibold tracking-tight text-project-hub-ink-strong sm:text-2xl"
                >
                  {feature.title}
                </h3>
                <p className="mt-1.5 text-sm text-project-hub-ink">{feature.tagline}</p>
                <p className="mt-4 text-sm leading-6 text-project-hub-ink-subtle">{feature.body}</p>
                <ul className="mt-5 flex flex-col gap-2">
                  {feature.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-start gap-2 text-xs text-project-hub-ink-subtle">
                      <ArrowRightIcon
                        size={12}
                        weight="bold"
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-project-hub-ink-faint"
                      />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
