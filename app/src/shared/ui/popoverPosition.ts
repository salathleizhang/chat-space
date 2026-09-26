/**
 * 浮层的落位计算：面板里的下拉/选择器把弹层 portal 到 body 之后，弹层已经不受父级
 * overflow 裁切，但**仍然会跑出视口**——本文件存在的唯一理由就是这件事。
 *
 * 右侧栏贴图列表的换图按钮就同时踩了两个方向：它在右边缘，弹层按锚点左对齐铺开会把
 * 右边一整列缩略图推出视口；它又可能落在面板顶部，弹层一律向上展开会把前几行排到
 * y < 0 的位置，用户根本点不到。所以落位必须先量两侧余量、再决定朝哪边开，宽高都夹进
 * 可用范围。
 */

export interface PopoverPlacement {
  left: number;
  /** 内容至少这么宽；调用方据此设 minWidth，实际更宽时由内容自己撑开 */
  minWidth: number;
  /** 夹到可用空间后的高度上限；内容更高时由弹层自身滚动 */
  maxHeight: number;
  /** 向上展开时给 bottom；向下展开时给 top。二选一，另一个为 undefined */
  top?: number;
  bottom?: number;
  openUp: boolean;
}

/** 锚点与弹层之间的间隙 */
const GAP = 6;
/** 弹层与视口边缘至少留这么多 */
const MARGIN = 8;
/** 无论空间多小都至少留这么高，否则弹层会塌成一条看不见的缝 */
const MIN_HEIGHT = 120;

export interface PopoverOptions {
  /** 内容理想高度；用来判断哪一侧"装得下"，实际高度仍以余量为准 */
  preferredHeight: number;
  /** 内容最小宽度；同时用于把弹层横向夹回视口内 */
  minWidth?: number;
  gap?: number;
}

export function placePopover(anchor: DOMRect, options: PopoverOptions): PopoverPlacement {
  const gap = options.gap ?? GAP;
  const minWidth = Math.max(options.minWidth ?? 0, anchor.width);

  const spaceAbove = anchor.top - gap;
  const spaceBelow = window.innerHeight - anchor.bottom - gap;
  // 优先选装得下理想高度的一侧；两侧都装不下时选更宽裕的那侧
  const openUp =
    spaceAbove >= options.preferredHeight ||
    (spaceBelow < options.preferredHeight && spaceAbove > spaceBelow);
  const available = openUp ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(MIN_HEIGHT, Math.min(options.preferredHeight, available));

  // 视口比弹层还窄时（极端小窗）夹不出合法区间，退到左边距，让弹层自己滚
  const maxLeft = window.innerWidth - minWidth - MARGIN;
  const left = maxLeft <= MARGIN ? MARGIN : Math.max(MARGIN, Math.min(anchor.left, maxLeft));

  const base = { left, minWidth, maxHeight, openUp };
  return openUp
    ? { ...base, bottom: window.innerHeight - anchor.top + gap }
    : { ...base, top: anchor.bottom + gap };
}
