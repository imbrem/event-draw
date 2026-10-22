import { measuredDeliveries, type InkData, type Sample } from './model.ts';

export interface StrokeTimeline { points: Sample[]; times: number[]; duration: number; receiptFallbacks: number }
/** Same measured stream as rendering. Missing timestamps use receipt clocks;
 * regressions clamp to the previous time so playback can only move forward.
 */
export function strokeTimeline(data: InkData): StrokeTimeline {
  const points: Sample[] = [], times: number[] = [];
  let origin: number | undefined, previous = 0, receiptFallbacks = 0;
  for (const delivery of measuredDeliveries(data)) {
    for (const point of delivery.coalesced.length ? delivery.coalesced : [delivery.reported]) {
      let clock: number | undefined;
      if (typeof point.timeStamp === 'number' && Number.isFinite(point.timeStamp)) clock = point.timeStamp;
      else {
        receiptFallbacks++;
        if (typeof delivery.receivedAt === 'number' && Number.isFinite(delivery.receivedAt)) clock = delivery.receivedAt;
      }
      if (origin === undefined && clock !== undefined) origin = clock;
      const at = clock === undefined ? previous : Math.max(previous, clock - origin!);
      points.push(point); times.push(at); previous = at;
    }
  }
  return { points, times, duration: previous, receiptFallbacks };
}
/** Number of observed samples available at this replay time, including ties. */
export function samplesAt(times: number[], at: number): number {
  let low = 0, high = times.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (times[mid] <= at) low = mid + 1;
    else high = mid;
  }
  return low;
}
