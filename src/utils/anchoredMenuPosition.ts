/** Fixed menu width (matches `w-52` = 13rem). */
export const ANCHORED_MENU_WIDTH_PX = 208;

export type AnchoredMenuPosition = {
  top: number;
  right: number;
  /** Only when the menu cannot fit in the viewport without clipping (very short screens). */
  maxHeight?: number;
};

/**
 * Place a fixed dropdown below the anchor when there is room; otherwise fully above (no in-menu scroll).
 * `menuHeight` should be measured from the rendered menu (useLayoutEffect).
 */
export function computeAnchoredMenuPosition(
  anchor: DOMRect,
  menuHeight: number,
  options?: { gap?: number; margin?: number }
): AnchoredMenuPosition {
  const gap = options?.gap ?? 4;
  const margin = options?.margin ?? 8;
  const right = Math.max(margin, window.innerWidth - anchor.right);
  const h = Math.max(menuHeight, 1);

  const spaceBelow = window.innerHeight - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;

  const openAbove = h > spaceBelow && spaceAbove >= spaceBelow;

  if (openAbove) {
    const top = Math.max(margin, anchor.top - gap - h);
    const bottom = top + h;
    if (bottom > window.innerHeight - margin) {
      return {
        top: margin,
        right,
        maxHeight: window.innerHeight - margin * 2,
      };
    }
    return { top, right };
  }

  if (h <= spaceBelow) {
    return { top: anchor.bottom + gap, right };
  }

  if (spaceAbove >= h) {
    return { top: anchor.top - gap - h, right };
  }

  return {
    top: margin,
    right,
    maxHeight: window.innerHeight - margin * 2,
  };
}
