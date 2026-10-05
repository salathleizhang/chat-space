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

/** 缩略图卡：图 + 世界名 + 一句话。整张卡是一个按钮。 */
function WorldCard({ world, onOpen }: { world: ShowcaseWorld; onOpen: (world: ShowcaseWorld) => void }) {
  /** 没有项目 slug = 占位项，点击只能回到项目列表 */
  const isPlaceholder = !world.projectSlug;
  return (
    <button
      type="button"
      className="group flex w-full flex-col overflow-hidden rounded-media border border-project-hub-ink-faint/25 bg-project-hub-fill text-left transition-[border-color,box-shadow,translate] duration-200 ease-spring hover:border-project-hub-ink-faint/60 hover:shadow-[0_18px_36px_-22px_rgb(22_22_24/0.5)] motion-safe:hover:-translate-y-0.5"
      onClick={() => onOpen(world)}
      aria-label={isPlaceholder ? `Browse projects (${world.name} is a placeholder world)` : `Enter world ${world.name}`}
    >
      <span className="relative block aspect-[3/2] w-full overflow-hidden bg-project-hub-ink-strong">
        <img
          src={world.thumbnail}
          alt={`${world.name} preview`}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover transition-transform duration-500 ease-spring group-hover:scale-[1.05]"
        />
        {/* 底部渐变只为压住白字，不参与语义 */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/75 via-black/25 to-transparent"
        />
        {/* 标签走右上角而不是跟名字并排：4 列时卡片只有 ~230px，并排会把世界名挤到截断 */}
        <span className="absolute top-2.5 right-2.5 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          {world.setting}
        </span>
        {isPlaceholder && (
          <span className="absolute top-2.5 left-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white/90">
            Placeholder
          </span>
        )}
        <span className="absolute inset-x-3 bottom-2.5 block truncate text-sm font-semibold text-white drop-shadow-sm">
          {world.name}
        </span>
      </span>
      <span className="flex flex-1 flex-col gap-2 px-3.5 pt-3 pb-3.5">
        <span className="min-h-9 text-xs leading-4.5 text-project-hub-ink-subtle">{world.description}</span>
        <span className="mt-auto flex items-center gap-1 text-[11px] font-medium text-project-hub-ink">
          {isPlaceholder ? "Browse projects" : "Enter world"}
          <ArrowUpRightIcon
            size={12}
            weight="bold"
            aria-hidden="true"
            className="transition-transform duration-200 ease-spring group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          />
        </span>
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
 * 现在 `PRODUCT_FEATURES` 里只有静态图，所以走 `<img>` 分支，并挂一个极慢的
 * `media-drift` 让它看起来是「动图」；等录屏接上（填 `video`）就直接换成分支里的
 * `<video>`，`image` 退化成 poster。
 */
function FeatureMedia({ feature }: { feature: ProductFeature }) {
  return (
    <div className="relative overflow-hidden rounded-media border border-project-hub-ink-faint/20 bg-project-hub-ink-strong shadow-[0_24px_60px_-32px_rgb(22_22_24/0.55)]">
      {feature.video ? (
        <video
          className="aspect-16/10 w-full object-cover"
          src={feature.video}
          poster={feature.image}
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
