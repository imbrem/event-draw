import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gesture } from './helpers.ts';
import { localize } from '../src/model.ts';
import { DEFAULT_INK_POLICY, tryProcessInk } from '../src/ink.ts';
import { LiveInk } from '../src/live-ink.ts';
test('incremental built-in preview equals full processing across coalescing, raw arrival and pen-up', () => {
  const input = gesture([
    [10, 20],
    [30, 35],
    [50, 35],
    [70, 40],
  ]);
  input.policy = structuredClone(DEFAULT_INK_POLICY);
  for (const delivery of input.data.deliveries) {
    delivery.reported.pointerType = 'pen';
    delivery.reported.buttons = 1;
    delivery.reported.pressure = 0.7;
  }
  input.data.deliveries[2].type = 'pointerrawupdate';
  input.data.deliveries[2].coalesced = [
    { ...input.data.deliveries[2].reported, x: 40, pressure: 0.2 },
    input.data.deliveries[2].reported,
  ];
  input.data.deliveries[3].reported.buttons = 0;
  input.data.deliveries[3].reported.pressure = 0;
  const deliveries = input.data.deliveries;
  input.data = { deliveries: [] };
  const live = new LiveInk();
  let previous: unknown;
  for (const delivery of deliveries) {
    input.data.deliveries.push(delivery);
    const output = live.update(input),
      full = localize(input.data);
    assert.deepEqual(output.points, tryProcessInk(full.data, input.policy).points);
    assert.deepEqual(output.origin, full.origin);
    if (delivery.type !== 'pointerrawupdate' && previous) assert.equal(output.points, previous);
    previous = output.points;
  }
  input.policy.smoothing.id = 'moving-average@1';
  assert.equal(live.update(input).incremental, false);
  input.policy.smoothing.id = 'none@1';
  assert.deepEqual(live.update(input).points, tryProcessInk(localize(input.data).data, input.policy).points);
  input.policy.rejection.id = 'pen-only@1';
  input.data.deliveries[0].reported.pointerType = 'touch';
  assert.deepEqual(live.update(input).points, []);
  assert.deepEqual(live.update(input).points, []);
});
