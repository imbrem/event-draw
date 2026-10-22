import type { ViewBox } from '../model.ts';

/** CSS window and page coordinates share a scale; raw observations retain the transform. */
export function inkWindow(
  paper: { left: number; top: number; width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
  pageWidth: number,
): { left: number; top: number; width: number; height: number; view: ViewBox } {
  const scale = paper.width / pageWidth;
  const left = Math.max(0, viewport.left - paper.left);
  const top = Math.max(0, viewport.top - paper.top);
  const width = Math.max(1, Math.min(paper.width, viewport.left + viewport.width - paper.left) - left);
  const height = Math.max(1, Math.min(paper.height, viewport.top + viewport.height - paper.top) - top);
  return {
    left,
    top,
    width,
    height,
    view: {
      x: left / scale,
      y: top / scale,
      width: width / scale,
      height: height / scale,
    },
  };
}
