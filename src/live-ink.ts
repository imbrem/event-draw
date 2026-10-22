import { localize, type Gesture, type Point } from './model.ts';
import { DEFAULT_INK_POLICY, policyJson, tryProcessInk, type InkPoint } from './ink.ts';
/** Exact append-only fast path for built-in local processors. Experimental or
 * nonlocal processors keep the full-trace API unless they declare an equivalent
 * incremental contract in a future version. Raw-update arrival invalidates moves.
 */
export class LiveInk {
  private count = 0;
  private raw = false;
  private previousPressure = 0.5;
  private key = '';
  points: InkPoint[] = [];
  origin: Point = { x: 0, y: 0 };
  generation = 0;
  update(gesture: Gesture): { points: InkPoint[]; origin: Point; generation: number; incremental: boolean } {
    const policy = gesture.policy ?? DEFAULT_INK_POLICY,
      key = policyJson(policy),
      deliveries = gesture.data.deliveries;
    const incremental =
      policy.smoothing.id === 'none@1' &&
      ['constant@1', 'pen-pressure@1'].includes(policy.pressure.id) &&
      ['none@1', 'pen-only@1'].includes(policy.rejection.id);
    if (!incremental) {
      this.count = 0;
      this.key = '';
      const { data, origin } = localize(gesture.data);
      this.points = tryProcessInk(data, policy).points;
      this.origin = origin;
      this.generation++;
      return { points: this.points, origin, generation: this.generation, incremental: false };
    }
    const raw = this.raw || deliveries.slice(this.count).some((d) => d.type === 'pointerrawupdate');
    if (this.key !== key || raw !== this.raw || deliveries.length < this.count) {
      this.count = 0;
      this.points = [];
      this.previousPressure = 0.5;
      this.generation++;
    }
    this.key = key;
    this.raw = raw;
    const firstDelivery = deliveries.find((d) => !raw || d.type !== 'pointermove'),
      first = firstDelivery?.coalesced[0] ?? firstDelivery?.reported;
    if (policy.rejection.id === 'pen-only@1' && first?.pointerType !== 'pen') {
      this.points = [];
      this.count = deliveries.length;
      return { points: this.points, origin: this.origin, generation: ++this.generation, incremental: false };
    }
    for (const delivery of deliveries.slice(this.count)) {
      if (raw && delivery.type === 'pointermove') continue;
      for (const sample of delivery.coalesced.length ? delivery.coalesced : [delivery.reported]) {
        if (!this.points.length) this.origin = { x: sample.x, y: sample.y };
        let factor = 1;
        if (policy.pressure.id === 'pen-pressure@1' && sample.pointerType === 'pen') {
          let pressure = sample.pressure;
          if (pressure === null || !Number.isFinite(pressure) || pressure < 0 || pressure > 1) pressure = 0.5;
          if (sample.buttons === 0 && pressure === 0) pressure = this.previousPressure;
          this.previousPressure = pressure;
          factor = 0.35 + 1.3 * pressure;
        }
        this.points.push({
          x: sample.x - this.origin.x,
          y: sample.y - this.origin.y,
          sourceIndex: this.points.length,
          widthFactor: factor,
        });
      }
    }
    this.count = deliveries.length;
    return { points: this.points, origin: this.origin, generation: this.generation, incremental: true };
  }
}
