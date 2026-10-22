import type { Point, ViewBox } from '../model.ts';

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
