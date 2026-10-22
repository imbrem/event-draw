import { measuredSamples, type Gesture, type Point, type ViewBox, type VisibleShape } from './model.ts';
import { planErasure, shapePath } from './geometry.ts';

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
export interface Scene {
  shapes: VisibleShape[];
  pending: Gesture[];
  active: Gesture | null;
  view: ViewBox;
  hover: Point | null;
  tool: string;
  radius: number;
}
export function render(canvas: HTMLCanvasElement, scene: Scene) {
  const context = prepareCanvas(canvas, scene.view);
  if (!context) return;
  const eraser = [scene.active, ...scene.pending].find((g) => g && !g.cancelled && g.tool.startsWith('erase'));
  const erased = new Map(eraser ? planErasure(scene.shapes, measuredSamples(eraser.data),
    eraser.radius, eraser.tool === 'erase-strokes').map((e) => [e.shape.id, e.ranges]) : []);
  for (const shape of scene.shapes) {
    const ranges = erased.get(shape.id) ?? [[shape.start_index, shape.end_index] as [number, number]];
    for (const range of ranges) drawPath(context, shapePath(shape, range), shape.color, shape.line_width);
  }
  for (const gesture of [...scene.pending, ...(scene.active ? [scene.active] : [])]) {
    if (gesture.tool === 'pen' && !gesture.cancelled) {
      drawPath(context, measuredSamples(gesture.data), gesture.style.color, gesture.style.lineWidth);
    }
  }
  if (scene.hover && scene.tool.startsWith('erase')) {
    context.beginPath();
    context.arc(scene.hover.x, scene.hover.y, scene.radius, 0, Math.PI * 2);
    context.fillStyle = '#6c8c8b22';
    context.fill();
    context.strokeStyle = '#426666';
    context.lineWidth = scene.view.width / canvas.getBoundingClientRect().width;
    context.stroke();
  }
}
