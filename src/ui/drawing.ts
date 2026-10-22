import type { Point, ViewBox } from '../model.ts';
import type { InkPoint } from '../ink.ts';

/** Union of variable-radius discs and their tangent hulls, filled once so
 * alpha does not accumulate at overlapping samples.
 */
export function drawInk(context: CanvasRenderingContext2D, points: InkPoint[], color: string, baseWidth: number, opacity = 1, blend: GlobalCompositeOperation = 'source-over') {
  context.save(); context.globalAlpha *= opacity; context.globalCompositeOperation = blend;
  context.fillStyle = color; context.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i], r = p.widthFactor * baseWidth / 2;
    context.moveTo(p.x + r, p.y); context.arc(p.x, p.y, r, 0, 2 * Math.PI); context.closePath();
    if (!i) continue;
    const a = points[i - 1], ar = a.widthFactor * baseWidth / 2, dx = p.x - a.x, dy = p.y - a.y, length = Math.hypot(dx, dy);
    if (length <= Math.abs(r - ar)) continue;
    const ux = dx / length, uy = dy / length, along = (ar - r) / length, side = Math.sqrt(1 - along * along);
    const nx = ux * along - uy * side, ny = uy * along + ux * side;
    const mx = ux * along + uy * side, my = uy * along - ux * side;
    context.moveTo(a.x + nx * ar, a.y + ny * ar); context.lineTo(a.x + mx * ar, a.y + my * ar);
    context.lineTo(p.x + mx * r, p.y + my * r); context.lineTo(p.x + nx * r, p.y + ny * r); context.closePath();
  }
  context.fill();
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
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d')!;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(width / view.width, 0, 0, height / view.height,
    -view.x * width / view.width, -view.y * height / view.height);
  return context;
}
