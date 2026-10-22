import type { Point, ViewBox } from '../model.ts';
import type { InkPoint } from '../ink.ts';

/** Union of variable-radius discs and their tangent hulls, filled once so
 * alpha does not accumulate at overlapping samples.
 */
export function drawInk(
  context: CanvasRenderingContext2D,
  points: InkPoint[],
  color: string,
  baseWidth: number,
  opacity = 1,
  blend: GlobalCompositeOperation = 'source-over',
) {
  const path = new Path2D();
  appendInkPath(path, points, baseWidth);
  paintInkPath(context, path, color, opacity, blend);
}
export function appendInkPath(path: Path2D, points: InkPoint[], baseWidth: number, from = 0) {
  for (let i = from; i < points.length; i++) {
    const p = points[i],
      r = (p.widthFactor * baseWidth) / 2;
    path.moveTo(p.x + r, p.y);
    path.arc(p.x, p.y, r, 0, 2 * Math.PI);
    path.closePath();
    if (!i) continue;
    const a = points[i - 1],
      ar = (a.widthFactor * baseWidth) / 2,
      dx = p.x - a.x,
      dy = p.y - a.y,
      length = Math.hypot(dx, dy);
    if (length <= Math.abs(r - ar)) continue;
    const ux = dx / length,
      uy = dy / length,
      along = (ar - r) / length,
      side = Math.sqrt(1 - along * along);
    const nx = ux * along - uy * side,
      ny = uy * along + ux * side;
    const mx = ux * along + uy * side,
      my = uy * along - ux * side;
    path.moveTo(a.x + nx * ar, a.y + ny * ar);
    path.lineTo(a.x + mx * ar, a.y + my * ar);
    path.lineTo(p.x + mx * r, p.y + my * r);
    path.lineTo(p.x + nx * r, p.y + ny * r);
    path.closePath();
  }
}
export function paintInkPath(
  context: CanvasRenderingContext2D,
  path: Path2D,
  color: string,
  opacity = 1,
  blend: GlobalCompositeOperation = 'source-over',
) {
  context.save();
  context.globalAlpha *= opacity;
  context.globalCompositeOperation = blend;
  context.fillStyle = color;
  context.fill(path);
  context.restore();
}

export function drawPath(context: CanvasRenderingContext2D, points: Point[], color: string, width: number) {
  if (!points.length) return;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
  context.beginPath();
  context.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
  context.fill();
}
export function prepareCanvas(canvas: HTMLCanvasElement, view: ViewBox): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(16_000_000 / (rect.width * rect.height)));
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d')!;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(
    width / view.width,
    0,
    0,
    height / view.height,
    (-view.x * width) / view.width,
    (-view.y * height) / view.height,
  );
  return context;
}
