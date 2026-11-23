/**
 * Browsers cap how tall an element can be (Firefox ~17.9M px, Chrome ~33.5M px, and
 * Safari starts misbehaving earlier). A million 36px rows is 36M px, so above this
 * height the scrollbar is compressed: scroll position maps proportionally onto the
 * virtual content, and the rows layer is offset so rows still move pixel-perfectly.
 */
export const MAX_SCROLL_HEIGHT = 8_000_000;

export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan?: number;
  maxScrollHeight?: number;
}

export interface RowWindow {
  /** First rendered row (inclusive). */
  start: number;
  /** Last rendered row (exclusive). */
  end: number;
  /** Where to place row `start`, in scroll-container (body) coordinates. */
  offsetY: number;
  /** Height of the scrollable body. */
  scrollHeight: number;
  /** Virtual pixels per real scroll pixel (1 unless compressed). */
  ratio: number;
}

export function scrollMetrics(rowCount: number, rowHeight: number, viewportHeight: number, maxScrollHeight = MAX_SCROLL_HEIGHT) {
  const contentHeight = rowCount * rowHeight;
  const scrollHeight = Math.min(contentHeight, maxScrollHeight);
  const realRange = scrollHeight - viewportHeight;
  const virtualRange = contentHeight - viewportHeight;
  const ratio = realRange > 0 && virtualRange > realRange ? virtualRange / realRange : 1;
  return { contentHeight, scrollHeight, ratio };
}

export function computeWindow({
  scrollTop, viewportHeight, rowHeight, rowCount, overscan = 6, maxScrollHeight = MAX_SCROLL_HEIGHT,
}: WindowInput): RowWindow {
  const { scrollHeight, ratio } = scrollMetrics(rowCount, rowHeight, viewportHeight, maxScrollHeight);
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, scrollHeight - viewportHeight)));
  const virtualTop = top * ratio;
  const first = Math.min(Math.floor(virtualTop / rowHeight), Math.max(0, rowCount - 1));
  const visible = Math.ceil(viewportHeight / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(rowCount, first + visible + overscan);
  // Row `start` sits (virtualTop - start * rowHeight) above the viewport's top edge.
  const offsetY = top - (virtualTop - start * rowHeight);
  return { start, end, offsetY, scrollHeight, ratio };
}

/**
 * The scrollTop that brings `index` fully into view, moving as little as possible.
 * Returns `scrollTop` unchanged when the row is already visible.
 */
export function scrollTopForRow(index: number, { scrollTop, viewportHeight, rowHeight, rowCount, maxScrollHeight = MAX_SCROLL_HEIGHT }: WindowInput): number {
  const { ratio } = scrollMetrics(rowCount, rowHeight, viewportHeight, maxScrollHeight);
  const virtualTop = scrollTop * ratio;
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < virtualTop) return rowTop / ratio;
  if (rowBottom > virtualTop + viewportHeight) return (rowBottom - viewportHeight) / ratio;
  return scrollTop;
}
