import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureDelivery } from '../src/capture.ts';
import { measuredSamples } from '../src/model.ts';

test('capture preserves defaults, missing fields, coalesced and predicted observations separately', () => {
  const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 600 }) } as HTMLCanvasElement;
  const base = { type: 'pointermove', clientX: 15.125, clientY: 25.5, pressure: 0.5, timeStamp: 3 };
  const event = {
    ...base,
    getCoalescedEvents: () => [{ ...base, clientX: 16.25 }],
    getPredictedEvents: () => [{ ...base, clientX: 18.75 }],
  } as unknown as PointerEvent;
  const d = captureDelivery(event, canvas);
  assert.equal(d.reported.pressure, 0.5); // Keep the reported default, never infer hardware support.
  assert.equal(d.reported.tiltX, null);
  assert.equal(d.reported.x, 10.25);
  assert.equal(d.reported.y, 11);
  assert.equal(measuredSamples({ deliveries: [d] })[0].x, 12.5);
  assert.equal(d.predicted[0].x, 17.5);
  assert.equal(d.reported.clientX, 15.125);
  assert.deepEqual(d.clientToPage, [2, 0, 0, 2, -20, -40]);
});

test('missing or failing optional APIs fall back to the delivered observation', () => {
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1200 }) } as HTMLCanvasElement;
  const event = {
    type: 'pointermove', clientX: 5, clientY: 6, timeStamp: 3,
    getPredictedEvents: () => { throw new Error('unsupported'); },
  } as unknown as PointerEvent;
  const d = captureDelivery(event, canvas);
  assert.deepEqual(d.predicted, []);
  assert.deepEqual(d.coalesced, []);
  assert.equal(measuredSamples({ deliveries: [d] }).length, 1);
});

test('raw updates are rendered without also drawing overlapping pointermove batches', () => {
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1200 }) } as HTMLCanvasElement;
  const base = { clientX: 5, clientY: 6, timeStamp: 3 } as PointerEvent;
  const move = captureDelivery({ ...base, type: 'pointermove' } as PointerEvent, canvas);
  const raw = captureDelivery({ ...base, type: 'pointerrawupdate' } as PointerEvent, canvas);
  const data = { deliveries: [move, raw] };
  assert.equal(data.deliveries.length, 2);
  assert.equal(measuredSamples(data).length, 1);
});
