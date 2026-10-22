import { GEOMETRY_BOUNDS_PAD, outputPoints, placeInk, remainingRanges } from './geometry.ts';
import type { InkPoint } from './ink.ts';
import type { Point, Range, VisibleShape } from './model.ts';
import { InkIndex } from './spatial.ts';

export interface Erasure {
  shape: VisibleShape;
  ranges: Range[];
}

/** Disposable geometry state for one fixed scene/radius/tool. Append only new
 * measured samples; keep the shared endpoint so sparse crossings are preserved.
 * Neither raw observations nor the journal are modified by a preview.
 */
export class ErasurePlanner {
  readonly ranges = new Map<number, Range[]>();
  private shapes: Map<number, VisibleShape>;
  private index: InkIndex;
  private ink = new Map<number, { points: InkPoint[]; radii: number[] }>();
  private last: Point | null = null;
  private radius: number;
  private whole: boolean;
  constructor(shapes: VisibleShape[], radius: number, whole: boolean) {
    this.radius = radius;
    this.whole = whole;
    this.shapes = new Map(shapes.map((shape) => [shape.id, shape]));
    this.index = new InkIndex(shapes);
  }
  append(samples: readonly Point[]) {
    for (const b of samples) {
      const a = this.last ?? b;
      this.last = b;
      // Painted bounds already include variable width, scale and rotation.
      const pad = this.radius + GEOMETRY_BOUNDS_PAD;
      const candidates = this.index.query({
        x: Math.min(a.x, b.x) - pad,
        y: Math.min(a.y, b.y) - pad,
        width: Math.abs(b.x - a.x) + 2 * pad,
        height: Math.abs(b.y - a.y) + 2 * pad,
      });
      for (const id of candidates) {
        const shape = this.shapes.get(id)!;
        const before = this.ranges.get(id) ?? [[shape.start_index, shape.end_index] as Range];
        if (!before.length) continue;
        let ink = this.ink.get(id);
        if (!ink) {
          const points = placeInk(shape, outputPoints(shape));
          ink = { points, radii: points.map((p) => (p.widthFactor * shape.line_width) / 2) };
          this.ink.set(id, ink);
        }
        const after: Range[] = [];
        let changed = false;
        for (const range of before) {
          const kept = remainingRanges(ink.points, range, [a, b], this.radius, ink.radii);
          changed ||= kept.length !== 1 || kept[0][0] !== range[0] || kept[0][1] !== range[1];
          after.push(...kept);
          if (changed && this.whole) break;
        }
        // Stable array identity also lets renderers reuse unchanged fragment paths.
        if (changed) this.ranges.set(id, this.whole ? [] : after);
      }
    }
  }
}

/** Same planner for committed edits and previews; retain scene paint order. */
export function planErasure(
  shapes: VisibleShape[],
  path: Point[],
  radius: number,
  whole: boolean,
): Erasure[] {
  const plan = new ErasurePlanner(shapes, radius, whole);
  plan.append(path);
  return shapes.flatMap((shape) => {
    const ranges = plan.ranges.get(shape.id);
    return ranges ? [{ shape, ranges }] : [];
  });
}
