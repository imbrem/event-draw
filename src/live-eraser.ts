import { ErasurePlanner } from './erasure.ts';
import type { Gesture, InkData, VisibleShape } from './model.ts';

/** Append-only capture adapter. The first raw-update delivery replaces the
 * pointermove summary stream, so that transition rebuilds the preview once.
 */
export class LiveEraser {
  private data: InkData | null = null;
  private shapes: VisibleShape[] = [];
  private count = 0;
  private raw = false;
  private radius = 0;
  private whole = false;
  private plan: ErasurePlanner | null = null;
  update(gesture: Gesture, shapes: VisibleShape[]) {
    const deliveries = gesture.data.deliveries;
    const sameData = this.data === gesture.data && deliveries.length >= this.count;
    const raw =
      (sameData && this.raw) ||
      deliveries.slice(sameData ? this.count : 0).some((d) => d.type === 'pointerrawupdate');
    const whole = gesture.tool === 'erase-strokes';
    if (
      !sameData ||
      raw !== this.raw ||
      gesture.radius !== this.radius ||
      whole !== this.whole ||
      shapes.length !== this.shapes.length ||
      shapes.some((s, i) => s !== this.shapes[i])
    ) {
      this.plan = null;
      this.count = 0;
    }
    if (!this.plan) {
      this.plan = new ErasurePlanner(shapes, gesture.radius, whole);
      this.shapes = shapes.slice();
    }
    this.data = gesture.data;
    this.raw = raw;
    this.radius = gesture.radius;
    this.whole = whole;
    for (let i = this.count; i < deliveries.length; i++) {
      const delivery = deliveries[i];
      if (raw && delivery.type === 'pointermove') continue;
      this.plan.append(delivery.coalesced.length ? delivery.coalesced : [delivery.reported]);
    }
    this.count = deliveries.length;
    return this.plan.ranges;
  }
}
