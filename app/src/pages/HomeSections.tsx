import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import type { ProductFeature, ShowcaseWorld } from "./homeShowcase";
import { HOME_COPY, type HomeCopy } from "./homeCopy";
import { FeatureMedia } from "./HomeFeatureMedia";

/**
 * 首页搜索框以下的两段营销版式。
 *
 * 拆成独立文件而不是塞进 `HomePage.tsx`：页面本体只负责「创建项目」这条交互，
 * 数据由 `homeShowcase.ts` 给，媒体预览交互由 `HomeFeatureMedia.tsx` 负责，放一起会让
 * 首页那个已经不小的组件再翻一倍。
 */

/**
 * 世界卡：整张卡就是一张缩略图，不再有正文——卡面上只留世界名、尺度标签和
 * 一个「打开」箭头，介绍文案没有信息量还占掉一半卡高。
 *
 * 版式与字体由 home.css 的首页作用域控制，不影响工作台。
 */
function WorldCard({ world, onOpen, copy }: { world: ShowcaseWorld; onOpen: (world: ShowcaseWorld) => void; copy: HomeCopy }) {
  /** 没有项目 slug = 占位项，点击只能回到项目列表 */
  const isPlaceholder = !world.projectSlug;
  return (
    <button
      type="button"
      className="home-world-card group relative block w-full overflow-hidden bg-project-hub-ink-strong text-left transition-[box-shadow,translate] duration-200 ease-spring focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-project-hub-ink-strong motion-safe:hover:-translate-y-1"
      onClick={() => onOpen(world)}
      aria-label={isPlaceholder ? copy.browseWorld(world.name) : copy.enterWorld(world.name)}
    >
      <img
        src={world.thumbnail}
        alt={copy.preview(world.name)}
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
          {copy.placeholder}
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
  copy = HOME_COPY.en,
}: {
  worlds: ShowcaseWorld[];
  onOpenWorld: (world: ShowcaseWorld) => void;
  /** 鼠标移入 / 键盘聚焦时提前拉起工作台 chunk，点击时命中 import() 的模块缓存 */
  onIntent?: () => void;
  copy?: HomeCopy;
}) {
  return (
    <section className="home-worlds" aria-labelledby="worlds-title">
      <div className="home-section-heading">
        <h2 id="worlds-title">
          {copy.worldsTitle}
        </h2>
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {worlds.map((world) => (
          <li key={world.id} onMouseEnter={onIntent} onFocus={onIntent}>
            <WorldCard world={world} onOpen={onOpenWorld} copy={copy} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 左图右文 / 左文右图交替的特性段落 */
export function FeatureShowcase({ features, copy = HOME_COPY.en }: { features: ProductFeature[]; copy?: HomeCopy }) {
  return (
    <section className="home-features" aria-labelledby="features-title">
      <div className="home-section-heading">
        <h2 id="features-title">
          {copy.featuresTitle}
        </h2>
      </div>

      <div className="home-feature-list">
        {features.map((feature, index) => {
          /** 偶数行图在左，奇数行图在右 */
          const mediaFirst = index % 2 === 0;
          return (
            <article
              key={feature.id}
              aria-labelledby={`feature-${feature.id}`}
              className="home-feature-row grid grid-cols-1 items-center gap-7 lg:grid-cols-2 lg:gap-14"
            >
              <div className={mediaFirst ? "" : "lg:order-2"}>
                <FeatureMedia feature={feature} copy={copy} />
              </div>
              <div className={`home-feature-copy ${mediaFirst ? "" : "lg:order-1"}`}>
                <h3
                  id={`feature-${feature.id}`}
                  className={`home-feature-title ${feature.poster ? "home-poster-title" : ""}`}
                >
                  {feature.title}
                </h3>
                {feature.poster ? (
                  <>
                    {feature.poster.knock && feature.poster.knockFirst && (
                      <p className="home-poster-knock">
                        <span>{feature.poster.knock}</span>
                      </p>
                    )}
                    {feature.poster.sub?.map((line) => (
                      <p key={line} className="home-poster-sub">
                        {line}
                      </p>
                    ))}
                    {feature.poster.knock && !feature.poster.knockFirst && (
                      <p className="home-poster-knock">
                        <span>{feature.poster.knock}</span>
                      </p>
                    )}
                  </>
                ) : (
                  <p className="home-feature-tagline">{feature.tagline}</p>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
