import { PluginRegistry } from './plugins.ts';
import { shapeInk, outputPoints } from './geometry.ts';
import type { Algorithm } from './ink.ts';
import type { Point, VisibleShape } from './model.ts';

export interface DetectionTrace {
  shapeId: number;
  rawId: number;
  outputId: number;
  complete: boolean;
  points: Point[];
  range: [number, number];
  placement: [number, number, number, number, number, number];
}
export interface BoxCandidate {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation: number;
  confidence: number;
  shapeIds: number[];
}
export interface DetectionInput {
  pageId: number;
  revision: number;
  traces: DetectionTrace[];
}
export type BoxDetector = (input: DetectionInput, options: Algorithm['options']) => BoxCandidate[];
export const DEFAULT_BOX_DETECTOR: Algorithm = { id: 'rectangle-outline@1', options: {} };
export function detectionTraces(shapes: VisibleShape[]): DetectionTrace[] {
  return shapes.map((s) => ({
    shapeId: s.id,
    rawId: s.raw_stroke_id,
    outputId: s.output_id,
    complete: s.start_index === 0 && s.end_index === outputPoints(s).length - 1,
    points: shapeInk(s).map(({ x, y }) => ({ x, y })),
    range: [s.start_index, s.end_index],
    placement: [
      Math.cos(s.rotation) * s.scale,
      Math.sin(s.rotation) * s.scale,
      -Math.sin(s.rotation) * s.scale,
      Math.cos(s.rotation) * s.scale,
      s.offset_x,
      s.offset_y,
    ],
  }));
}
export function sourceIdentity(traces: DetectionTrace[]) {
  return traces.map((t) => [t.shapeId, t.outputId, ...t.range, ...t.placement]).sort((a, b) => a[0] - b[0]);
}
export class BoxDetectors {
  readonly scripts = new PluginRegistry<BoxDetector>();
  readonly policy: Algorithm;
  constructor(policy = DEFAULT_BOX_DETECTOR) {
    this.policy = structuredClone(policy);
  }
  run(input: DetectionInput, policy = this.policy): BoxCandidate[] {
    const script = this.scripts.get(policy.id);
    if (!script) throw new Error('Unknown box detector: ' + policy.id);
    const allowed = new Set(input.traces.map((t) => t.shapeId));
    // A detector never gets mutable notebook state.
    const result = script(structuredClone(input), { ...policy.options });
    if (!Array.isArray(result) || result.length > 256)
      throw new Error('Detector returned too many or invalid candidates');
    return result.map((b) => {
      if (
        ![b.centerX, b.centerY, b.width, b.height, b.rotation, b.confidence].every(Number.isFinite) ||
        b.width <= 0 ||
        b.height <= 0 ||
        b.confidence < 0 ||
        b.confidence > 1 ||
        !b.shapeIds.length ||
        b.shapeIds.some((id) => !allowed.has(id))
      )
        throw new Error('Detector returned invalid geometry or foreign sources');
      return {
        centerX: b.centerX,
        centerY: b.centerY,
        width: b.width,
        height: b.height,
        rotation: b.rotation,
        confidence: b.confidence,
        shapeIds: [...new Set(b.shapeIds)].sort((a, b) => a - b),
      };
    });
  }
}
export function createBoxDetectors() {
  const detectors = new BoxDetectors();
  detectors.scripts.set(DEFAULT_BOX_DETECTOR.id, detectRectangles);
  return detectors;
}
export const boxDetectors = createBoxDetectors();

function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (list: Point[]) => {
    const result: Point[] = [];
    for (const p of list) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, p) <= 0) result.pop();
      result.push(p);
    }
    return result;
  };
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}
function orientedBounds(points: Point[]): Omit<BoxCandidate, 'shapeIds' | 'confidence'> | undefined {
  const boundary = hull(points);
  if (boundary.length < 3) return;
  let best: ReturnType<typeof orientedBounds>,
    area = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i],
      b = boundary[(i + 1) % boundary.length];
    let angle = Math.atan2(b.y - a.y, b.x - a.x);
    angle = ((((angle + Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4;
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const xs = points.map((p) => p.x * c + p.y * s),
      ys = points.map((p) => -p.x * s + p.y * c);
    const left = Math.min(...xs),
      right = Math.max(...xs),
      top = Math.min(...ys),
      bottom = Math.max(...ys);
    const width = right - left,
      height = bottom - top;
    if (width * height >= area - 1e-6) continue;
    area = width * height;
    const x = (left + right) / 2,
      y = (top + bottom) / 2;
    best = { centerX: x * c - y * s, centerY: x * s + y * c, width, height, rotation: angle };
  }
  return best;
}
/** Baseline research script: closed outlines, singly or as endpoint-connected
 * intact traces. Fits an oriented rectangle and checks all four edge coverages.
 * Deliberately conservative; it is not a general shape or handwriting model.
 */
export function detectRectangles(input: DetectionInput, options: Algorithm['options']): BoxCandidate[] {
  const gap = typeof options.gap === 'number' && options.gap > 0 ? Math.min(50, options.gap) : 12;
  const traces = input.traces
    .filter((t) => t.complete && t.points.length >= 2)
    .slice(-256)
    .map((t) => ({
      ...t,
      points: t.points.filter(
        (_, i) => i === t.points.length - 1 || i % Math.max(1, Math.ceil(t.points.length / 256)) === 0,
      ),
    }));
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= gap;
  const endpoints = (t: DetectionTrace) => [t.points[0], t.points.at(-1)!];
  const candidates: DetectionTrace[][] = traces.map((t) => [t]),
    seen = new Set<number>();
  for (const trace of traces) {
    if (seen.has(trace.shapeId)) continue;
    const group = [trace];
    seen.add(trace.shapeId);
    for (let i = 0; i < group.length; i++)
      for (const other of traces)
        if (
          !seen.has(other.shapeId) &&
          endpoints(group[i]).some((a) => endpoints(other).some((b) => near(a, b)))
        ) {
          seen.add(other.shapeId);
          group.push(other);
        }
    if (group.length > 1 && group.length <= 16) candidates.push(group);
  }
  const result: BoxCandidate[] = [];
  for (const group of candidates) {
    const ends = group.flatMap(endpoints);
    if (ends.some((a, i) => !ends.some((b, j) => i !== j && near(a, b)))) continue;
    const points = group.flatMap((t) => t.points),
      box = orientedBounds(points);
    if (!box || Math.min(box.width, box.height) < 20) continue;
    const tolerance = Math.max(3, Math.min(box.width, box.height) * 0.08),
      coverage = Array.from({ length: 4 }, () => new Set<number>());
    const c = Math.cos(box.rotation),
      s = Math.sin(box.rotation);
    const local = (p: Point) => ({
      x: (p.x - box.centerX) * c + (p.y - box.centerY) * s + box.width / 2,
      y: -(p.x - box.centerX) * s + (p.y - box.centerY) * c + box.height / 2,
    });
    let valid = true,
      length = 0;
    for (const trace of group)
      for (let i = 1; i < trace.points.length; i++) {
        const a = local(trace.points[i - 1]),
          b = local(trace.points[i]);
        length += Math.hypot(b.x - a.x, b.y - a.y);
        for (const p of [a, b, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }])
          if (
            Math.min(Math.abs(p.x), Math.abs(p.x - box.width), Math.abs(p.y), Math.abs(p.y - box.height)) >
            tolerance
          )
            valid = false;
        for (let side = 0; side < 4; side++) {
          const horizontal = side < 2,
            edge = side === 0 || side === 2 ? 0 : horizontal ? box.height : box.width;
          if (
            Math.abs((horizontal ? a.y : a.x) - edge) > tolerance ||
            Math.abs((horizontal ? b.y : b.x) - edge) > tolerance
          )
            continue;
          const size = horizontal ? box.width : box.height,
            from = Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y),
            to = Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
          for (let bin = 0; bin < 20; bin++)
            if (((bin + 0.5) / 20) * size >= from - tolerance && ((bin + 0.5) / 20) * size <= to + tolerance)
              coverage[side].add(bin);
        }
      }
    const score = Math.min(...coverage.map((bins) => bins.size / 20));
    if (valid && score >= 0.8 && length <= 1.7 * 2 * (box.width + box.height))
      result.push({ ...box, confidence: score, shapeIds: group.map((t) => t.shapeId) });
  }
  return result;
}
