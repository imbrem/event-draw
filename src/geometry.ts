import { measuredSamples, type InkData, type Point, type Range, type ViewBox, type VisibleShape } from './model.ts';

const EPS = 1e-8;
export function interpolate(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
export function pointAt(points: Point[], t: number): Point {
  const i = Math.min(Math.floor(t), points.length - 1);
  return interpolate(points[i], points[Math.min(i + 1, points.length - 1)], t - i);
}
export function slicePath(points: Point[], start: number, end: number): Point[] {
  if (!points.length) return [];
  const result = [pointAt(points, start)];
  for (let i = Math.floor(start) + 1; i < end; i++) result.push(points[i]);
  if (end > start) result.push(pointAt(points, end));
  return result;
}
export function rawPoints(shape: VisibleShape): Point[] {
  return shape.data_version === 1 ? measuredSamples(JSON.parse(shape.data_json) as InkData) : [];
}
export function shapePath(shape: VisibleShape, range: Range = [shape.start_index, shape.end_index]): Point[] {
  return slicePath(rawPoints(shape), ...range)
    .map((p) => ({ x: p.x + shape.offset_x, y: p.y + shape.offset_y }));
}
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function intersect(a: Range | null, b: Range | null): Range | null {
  if (!a || !b) return null;
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
  return lo <= hi ? [lo, hi] : null;
}
function linearBand(value: number, delta: number, lo: number, hi: number): Range | null {
  if (Math.abs(delta) < EPS) return value >= lo && value <= hi ? [0, 1] : null;
  const a = (lo - value) / delta, b = (hi - value) / delta;
  return intersect([Math.min(a, b), Math.max(a, b)], [0, 1]);
}
function circleInterval(p: Point, q: Point, center: Point, radius: number): Range | null {
  const dx = q.x - p.x, dy = q.y - p.y, x = p.x - center.x, y = p.y - center.y;
  const a = dx * dx + dy * dy;
  if (a < EPS * EPS) return Math.hypot(x, y) <= radius ? [0, 1] : null;
  const b = 2 * (x * dx + y * dy), c = x * x + y * y - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  return intersect([(-b - root) / (2 * a), (-b + root) / (2 * a)], [0, 1]);
}
function merge(ranges: Range[]): Range[] {
  const result: Range[] = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && range[0] <= last[1] + EPS) last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
}
/** Parameter intervals inside a swept capsule, including sparse segment crossings. */
function capsuleIntervals(p: Point, q: Point, a: Point, b: Point, radius: number): Range[] {
  const ranges = [circleInterval(p, q, a, radius), circleInterval(p, q, b, radius)];
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length > EPS) {
    const ux = dx / length, uy = dy / length;
    const x = p.x - a.x, y = p.y - a.y, vx = q.x - p.x, vy = q.y - p.y;
    ranges.push(intersect(
      linearBand(x * ux + y * uy, vx * ux + vy * uy, 0, length),
      linearBand(-x * uy + y * ux, -vx * uy + vy * ux, -radius, radius),
    ));
  }
  return ranges.filter((range): range is Range => range !== null);
}
/** Clip a polyline against the union of swept circular eraser areas. */
export function remainingRanges(points: Point[], range: Range, eraser: Point[], radius: number): Range[] {
  if (!points.length || !eraser.length) return [range];
  const segments = eraser.length === 1 ? [[eraser[0], eraser[0]]] :
    eraser.slice(1).map((p, i) => [eraser[i], p]);
  if (range[0] === range[1]) {
    const point = pointAt(points, range[0]);
    return segments.some(([a, b]) => distanceToSegment(point, a, b) <= radius) ? [] : [range];
  }
  const removed: Range[] = [];
  for (let i = Math.floor(range[0]); i < range[1]; i++) {
    for (const [a, b] of segments) {
      for (const interval of capsuleIntervals(points[i], points[i + 1], a, b, radius)) {
        const clipped = intersect([i + interval[0], i + interval[1]], range);
        if (clipped) removed.push(clipped);
      }
    }
  }
  const kept: Range[] = [];
  let cursor = range[0];
  for (const [lo, hi] of merge(removed)) {
    if (lo > cursor + EPS) kept.push([cursor, lo]);
    cursor = Math.max(cursor, hi);
  }
  if (cursor < range[1] - EPS) kept.push([cursor, range[1]]);
  return kept;
}
export interface Erasure { shape: VisibleShape; ranges: Range[] }
export function planErasure(shapes: VisibleShape[], path: Point[], radius: number, whole: boolean): Erasure[] {
  const result: Erasure[] = [];
  for (const shape of shapes) {
    const points = rawPoints(shape).map((p) => ({ x: p.x + shape.offset_x, y: p.y + shape.offset_y }));
    if (!points.length) continue;
    const range: Range = [shape.start_index, shape.end_index];
    const ranges = remainingRanges(points, range, path, radius + shape.line_width / 2);
    if (ranges.length !== 1 || ranges[0][0] !== range[0] || ranges[0][1] !== range[1]) {
      result.push({ shape, ranges: whole ? [] : ranges });
    }
  }
  return result;
}

function insidePolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
/** Select ink enclosed by or touching a closed lasso, including sparse crossings. */
export function lassoShapes(shapes: VisibleShape[], polygon: Point[]): VisibleShape[] {
  if (polygon.length < 3) return [];
  // Reject a tap/straight line, while allowing self-crossing lassos (even-odd fill).
  const first = polygon[0];
  if (!polygon.some((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return Math.abs((p.x - first.x) * (q.y - first.y) - (p.y - first.y) * (q.x - first.x)) > EPS;
  })) return [];
  const edges = polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]]);
  return shapes.filter((shape) => {
    const points = shapePath(shape);
    if (points.some((p) => insidePolygon(p, polygon))) return true;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[Math.min(i + 1, points.length - 1)];
      if (edges.some(([a, b]) => capsuleIntervals(p, q, a, b, shape.line_width / 2).length)) return true;
    }
    return false;
  });
}
export function selectionBounds(shapes: VisibleShape[]): ViewBox | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const shape of shapes) for (const p of shapePath(shape)) {
    const r = shape.line_width / 2;
    minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r);
    minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r);
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
export function gestureDelta(data: InkData): Point {
  const points = measuredSamples(data), first = points[0], last = points.at(-1);
  return first && last ? { x: last.x - first.x, y: last.y - first.y } : { x: 0, y: 0 };
}
