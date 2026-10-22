import {
  localize,
  measuredSamples,
  type Gesture,
  type Point,
  type Tool,
  type ViewBox,
  type VisibleShape,
} from './model.ts';
import { gestureDelta, planErasure, selectionBounds, shapeInk } from './geometry.ts';
import { appendInkPath, paintInkPath, drawInk, prepareCanvas } from './ui/drawing.ts';
import { DEFAULT_INK_POLICY, tryProcessInk } from './ink.ts';
import { LiveInk } from './live-ink.ts';
import { InkIndex } from './spatial.ts';
const settled = new WeakMap<
  HTMLCanvasElement,
  { key: string; canvas: HTMLCanvasElement; outputs: string[] }
>();

const live = new WeakMap<Gesture, { processor: LiveInk; path: Path2D; count: number; generation: number }>();
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
  const shapes = scene.shapes.map((shape) =>
    moving.has(shape.id)
      ? { ...shape, offset_x: shape.offset_x + delta.x, offset_y: shape.offset_y + delta.y }
      : shape,
  );
  const eraser = [scene.active, ...scene.pending].find(
    (g) => g && !g.cancelled && g.tool.startsWith('erase'),
  );
  const erased = new Map(
    eraser
      ? planErasure(shapes, measuredSamples(eraser.data), eraser.radius, eraser.tool === 'erase-strokes').map(
          (e) => [e.shape.id, e.ranges],
        )
      : [],
  );
  const key = JSON.stringify([
    canvas.width,
    canvas.height,
    scene.view,
    shapes.map((s) => [
      s.id,
      s.output_id,
      s.start_index,
      s.end_index,
      s.offset_x,
      s.offset_y,
      s.scale,
      s.rotation,
      s.style_id,
      s.color,
      s.line_width,
      s.opacity,
      s.blend_mode,
      s.paint_order,
    ]),
  ]);
  let cache = settled.get(canvas);
  if (!move && !eraser && cache?.key === key && shapes.every((s, i) => s.output_json === cache!.outputs[i])) {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(cache.canvas, 0, 0);
    context.restore();
  } else {
    const visible = new InkIndex(shapes).query(scene.view);
    for (const shape of shapes.filter((s) => visible.has(s.id))) {
      const ranges = erased.get(shape.id) ?? [[shape.start_index, shape.end_index] as [number, number]];
      for (const range of ranges)
        drawInk(
          context,
          shapeInk(shape, range),
          shape.color,
          shape.line_width,
          shape.opacity,
          shape.blend_mode,
        );
    }
    if (!move && !eraser) {
      const layer = cache?.canvas ?? document.createElement('canvas');
      layer.width = canvas.width;
      layer.height = canvas.height;
      layer.getContext('2d')!.drawImage(canvas, 0, 0);
      cache = { key, canvas: layer, outputs: shapes.map((s) => s.output_json) };
      settled.set(canvas, cache);
    }
  }
  const selected = new Set(scene.selected);
  const selectedShapes = shapes.filter((s) => selected.has(s.id));
  for (const shape of selectedShapes)
    drawInk(context, shapeInk(shape), '#3789a43b', shape.line_width + 5 * unit);
  const bounds = selectionBounds(selectedShapes);
  if (bounds) {
    context.save();
    context.strokeStyle = '#377e94';
    context.lineWidth = unit;
    context.setLineDash([5 * unit, 4 * unit]);
    context.strokeRect(
      bounds.x - 6 * unit,
      bounds.y - 6 * unit,
      bounds.width + 12 * unit,
      bounds.height + 12 * unit,
    );
    context.restore();
  }
  for (const gesture of [...scene.pending, ...(scene.active ? [scene.active] : [])]) {
    if ((gesture.tool === 'pen' || gesture.tool === 'highlighter') && !gesture.cancelled) {
      let cached = live.get(gesture);
      if (!cached) {
        cached = { processor: new LiveInk(), path: new Path2D(), count: 0, generation: -1 };
        live.set(gesture, cached);
      }
      const result = cached.processor.update(gesture);
      if (cached.generation !== result.generation || !result.incremental) {
        cached.path = new Path2D();
        cached.count = 0;
        cached.generation = result.generation;
      }
      appendInkPath(cached.path, result.points, gesture.style.lineWidth, cached.count);
      cached.count = result.points.length;
      context.save();
      context.translate(result.origin.x, result.origin.y);
      paintInkPath(context, cached.path, gesture.style.color, gesture.style.opacity, gesture.style.blendMode);
      context.restore();
    }
  }
  if (scene.active?.tool === 'lasso') {
    const points = measuredSamples(scene.active.data);
    if (points.length) {
      context.save();
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.fillStyle = '#3789a418';
      context.fill('evenodd');
      context.strokeStyle = '#377e94';
      context.lineWidth = unit;
      context.setLineDash([5 * unit, 4 * unit]);
      context.stroke();
      context.restore();
    }
  }
  if (scene.hover && (scene.tool.startsWith('erase') || scene.tool === 'restyle')) {
    context.beginPath();
    context.arc(scene.hover.x, scene.hover.y, scene.radius, 0, Math.PI * 2);
    context.fillStyle = '#6c8c8b22';
    context.fill();
    context.strokeStyle = '#426666';
    context.lineWidth = unit;
    context.stroke();
  }
}
