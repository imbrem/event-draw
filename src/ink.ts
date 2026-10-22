import { measuredSamples, type InkData, type Point, type Sample } from './model.ts';
import { PluginRegistry } from './plugins.ts';

/** IDs name immutable implementations: use a new version or code CID after edits. */
export interface Algorithm { id: string; options: Record<string, number | string | boolean | null> }
export interface InkPolicy { smoothing: Algorithm; pressure: Algorithm; rejection: Algorithm }
export interface TracePoint extends Point { sourceIndex: number }
/** Width is a dimensionless multiplier; color/base width/placement stay separate. */
export interface InkPoint extends TracePoint { widthFactor: number }
export interface InkOutput { kind: 'ink-path'; points: InkPoint[] }
export interface InkResult extends InkOutput { rejected: string | null }
export interface InkInput { samples: readonly Sample[] }
export type Smoother = (input: InkInput, options: Algorithm['options']) => TracePoint[];
export type Pressure = (input: InkInput, points: readonly TracePoint[], options: Algorithm['options']) => number[];
export type Rejector = (input: InkInput, options: Algorithm['options']) => string | null;
export const DEFAULT_INK_POLICY: InkPolicy = {
  smoothing: { id: 'none@1', options: {} }, pressure: { id: 'pen-pressure@1', options: {} },
  rejection: { id: 'none@1', options: {} },
};

/** Versioned, deterministic stages. Register plugins in the shared factory so
 * both live preview and the database worker use the same implementation.
 * Persisted outputs render without running any of these plugins again.
 */
export class InkProcessors {
  readonly smoothers = new PluginRegistry<Smoother>();
  readonly pressures = new PluginRegistry<Pressure>();
  readonly rejectors = new PluginRegistry<Rejector>();
  process(data: InkData, policy: InkPolicy): InkResult {
    const get = <T>(map: PluginRegistry<T>, spec: Algorithm): T => {
      const plugin = map.get(spec.id);
      if (!plugin) throw new Error('Unknown ink processor: ' + spec.id);
      return plugin;
    };
    const smooth = get(this.smoothers, policy.smoothing), pressure = get(this.pressures, policy.pressure);
    const reject = get(this.rejectors, policy.rejection);
    // Give plugins their own samples. They can never mutate the original capture.
    const input = { samples: measuredSamples(data).map((p) => ({ ...p })) };
    const rejected = reject(input, { ...policy.rejection.options });
    if (rejected !== null && typeof rejected !== 'string') throw new Error('Ink rejector must return a reason or null');
    if (rejected || !input.samples.length) return { kind: 'ink-path', points: [], rejected: rejected || 'No measured samples' };
    const points = smooth(input, { ...policy.smoothing.options });
    const widths = pressure(input, points, { ...policy.pressure.options });
    let previous = -1;
    if (points.length !== widths.length || points.some((p, i) => {
      const invalid = !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.sourceIndex) ||
        p.sourceIndex < 0 || p.sourceIndex > input.samples.length - 1 || p.sourceIndex <= previous ||
        !Number.isFinite(widths[i]) || widths[i] <= 0 || widths[i] > 8;
      previous = p.sourceIndex; return invalid;
    })) throw new Error('Ink processor produced invalid geometry or sample correspondence');
    return { kind: 'ink-path', rejected: null, points: points.map((p, i) => ({ x: p.x, y: p.y, sourceIndex: p.sourceIndex, widthFactor: widths[i] })) };
  }
}

export function createInkProcessors(): InkProcessors {
  const registry = new InkProcessors();
  registry.rejectors.set('none@1', () => null);
  registry.rejectors.set('pen-only@1', ({ samples }) => samples[0]?.pointerType === 'pen' ? null : 'Pen-only policy rejected this contact');
  registry.smoothers.set('none@1', ({ samples }) => samples.map((p, sourceIndex) => ({ x: p.x, y: p.y, sourceIndex })));
  registry.smoothers.set('moving-average@1', ({ samples }, options) => {
    const amount = typeof options.amount === 'number' ? Math.max(0, Math.min(1, options.amount)) : 0.65;
    return samples.map((p, sourceIndex) => {
      if (sourceIndex === 0 || sourceIndex === samples.length - 1) return { x: p.x, y: p.y, sourceIndex };
      const from = Math.max(0, sourceIndex - 2), to = Math.min(samples.length - 1, sourceIndex + 2);
      let x = 0, y = 0;
      for (let i = from; i <= to; i++) { x += samples[i].x; y += samples[i].y; }
      return { x: p.x + (x / (to - from + 1) - p.x) * amount,
        y: p.y + (y / (to - from + 1) - p.y) * amount, sourceIndex };
    });
  });
  registry.pressures.set('constant@1', (_input, points) => points.map(() => 1));
  registry.pressures.set('pen-pressure@1', ({ samples }, points) => {
    let previous = 0.5;
    const values = samples.map((sample) => {
      if (sample.pointerType !== 'pen') return 1;
      let p = sample.pressure;
      if (p === null || !Number.isFinite(p) || p < 0 || p > 1) p = 0.5;
      // Pen-up normally reports zero pressure; it is not a measured taper.
      if (sample.buttons === 0 && p === 0) p = previous;
      previous = p;
      return 0.35 + 1.3 * p;
    });
    return points.map(({ sourceIndex }) => {
      const i = Math.floor(sourceIndex), fraction = sourceIndex - i;
      return values[i] + ((values[Math.min(i + 1, values.length - 1)] ?? values[i]) - values[i]) * fraction;
    });
  });
  return registry;
}
export const inkProcessors = createInkProcessors();
/** A faulty experimental processor rejects a result, never the captured bytes. */
export function tryProcessInk(data: InkData, policy: InkPolicy, processors = inkProcessors): InkResult {
  try { return processors.process(data, policy); }
  catch (error) { return { kind: 'ink-path', points: [], rejected: 'Processor error: ' + String(error) }; }
}

/** Stable identity for a policy, independent of object key insertion order. */
export function policyJson(policy: InkPolicy): string {
  const spec = (a: Algorithm) => ({ id: a.id, options: Object.fromEntries(Object.entries(a.options).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
  return JSON.stringify({ smoothing: spec(policy.smoothing), pressure: spec(policy.pressure), rejection: spec(policy.rejection) });
}
export function inkPointAt(points: InkPoint[], at: number): InkPoint {
  const i = Math.min(Math.floor(at), points.length - 1), a = points[i], b = points[Math.min(i + 1, points.length - 1)], t = at - i;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    widthFactor: a.widthFactor + (b.widthFactor - a.widthFactor) * t,
    sourceIndex: a.sourceIndex + (b.sourceIndex - a.sourceIndex) * t };
}
export function sliceInk(points: InkPoint[], start: number, end: number): InkPoint[] {
  if (!points.length) return [];
  const result = [inkPointAt(points, start)];
  for (let i = Math.floor(start) + 1; i < end; i++) result.push(points[i]);
  if (end > start) result.push(inkPointAt(points, end));
  return result;
}
/** Map a raw-sample position onto a resampled output, preserving erased ranges. */
export function outputIndex(points: InkPoint[], sourceIndex: number): number {
  if (sourceIndex <= points[0].sourceIndex) return 0;
  for (let i = 1; i < points.length; i++) if (points[i].sourceIndex >= sourceIndex) {
    return i - 1 + (sourceIndex - points[i - 1].sourceIndex) / (points[i].sourceIndex - points[i - 1].sourceIndex);
  }
  return points.length - 1;
}
