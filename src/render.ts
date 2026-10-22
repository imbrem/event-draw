import { measuredSamples, type Gesture, type Point, type Tool, type ViewBox, type VisibleShape } from './model.ts';
import { gestureDelta, planErasure, selectionBounds, shapePath } from './geometry.ts';
import { drawPath, prepareCanvas } from './ui/drawing.ts';

export interface Scene {
  shapes: VisibleShape[];
  pending: Gesture[];
  active: Gesture | null;
  view: ViewBox;
  hover: Point | null;
  tool: Tool;
  radius: number;
  selected: number[];
}
export function render(canvas: HTMLCanvasElement, scene: Scene) {
  const context = prepareCanvas(canvas, scene.view);
  if (!context) return;
  const unit = scene.view.width / canvas.getBoundingClientRect().width;
  const move = [scene.active, ...scene.pending].find((g) => g && !g.cancelled && g.tool === 'move-selection');
  const delta = move ? gestureDelta(move.data) : { x: 0, y: 0 };
  const moving = new Set(move?.shapeIds);
  const shapes = scene.shapes.map((shape) => moving.has(shape.id) ?
    { ...shape, offset_x: shape.offset_x + delta.x, offset_y: shape.offset_y + delta.y } : shape);
  const eraser = [scene.active, ...scene.pending].find((g) => g && !g.cancelled && g.tool.startsWith('erase'));
  const erased = new Map(eraser ? planErasure(shapes, measuredSamples(eraser.data),
    eraser.radius, eraser.tool === 'erase-strokes').map((e) => [e.shape.id, e.ranges]) : []);
  for (const shape of shapes) {
    const ranges = erased.get(shape.id) ?? [[shape.start_index, shape.end_index] as [number, number]];
    for (const range of ranges) drawPath(context, shapePath(shape, range), shape.color, shape.line_width);
  }
  const selected = new Set(scene.selected);
  const selectedShapes = shapes.filter((s) => selected.has(s.id));
  for (const shape of selectedShapes) drawPath(context, shapePath(shape), '#3789a43b', shape.line_width + 5 * unit);
  const bounds = selectionBounds(selectedShapes);
  if (bounds) {
    context.save();
    context.strokeStyle = '#377e94'; context.lineWidth = unit; context.setLineDash([5 * unit, 4 * unit]);
    context.strokeRect(bounds.x - 6 * unit, bounds.y - 6 * unit, bounds.width + 12 * unit, bounds.height + 12 * unit);
    context.restore();
  }
  for (const gesture of [...scene.pending, ...(scene.active ? [scene.active] : [])]) {
    if (gesture.tool === 'pen' && !gesture.cancelled) {
      drawPath(context, measuredSamples(gesture.data), gesture.style.color, gesture.style.lineWidth);
    }
  }
  if (scene.active?.tool === 'lasso') {
    const points = measuredSamples(scene.active.data);
    if (points.length) {
      context.save(); context.beginPath(); context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.closePath(); context.fillStyle = '#3789a418'; context.fill('evenodd');
      context.strokeStyle = '#377e94'; context.lineWidth = unit; context.setLineDash([5 * unit, 4 * unit]);
      context.stroke(); context.restore();
    }
  }
  if (scene.hover && scene.tool.startsWith('erase')) {
    context.beginPath();
    context.arc(scene.hover.x, scene.hover.y, scene.radius, 0, Math.PI * 2);
    context.fillStyle = '#6c8c8b22';
    context.fill();
    context.strokeStyle = '#426666';
    context.lineWidth = unit;
    context.stroke();
  }
}
