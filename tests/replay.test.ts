import assert from 'node:assert/strict';
import { test } from 'node:test';
import { samplesAt, strokeTimeline } from '../src/replay.ts';
import { gesture } from './helpers.ts';

test('replay uses measured/coalesced clocks and excludes predictions and overlapping summaries', () => {
  const data = gesture([[0, 0], [10, 0], [20, 0]]).data;
  data.deliveries[0].reported.timeStamp = 100;
  data.deliveries[1].type = 'pointerrawupdate';
  data.deliveries[1].coalesced = [
    { ...data.deliveries[1].reported, timeStamp: 120 },
    { ...data.deliveries[1].reported, x: 15, timeStamp: 160 },
  ];
  data.deliveries[1].predicted = [{ ...data.deliveries[1].reported, x: 999, timeStamp: 300 }];
  data.deliveries[2].reported.timeStamp = 200;
  data.deliveries.splice(2, 0, { ...data.deliveries[1], type: 'pointermove', coalesced: [] });
  const before = JSON.stringify(data), timeline = strokeTimeline(data);
  assert.deepEqual(timeline.points.map((p) => p.x), [0, 10, 15, 20]);
  assert.deepEqual(timeline.times, [0, 20, 60, 100]);
  assert.equal(timeline.duration, 100);
  assert.equal(samplesAt(timeline.times, 50), 2);
  assert.equal(samplesAt(timeline.times, 100), 4);
  assert.equal(samplesAt(timeline.times, -1), 0);
  assert.equal(JSON.stringify(data), before);
});

test('missing timestamps use receipt clocks; regressions clamp and tied/empty clocks complete', () => {
  const data = gesture([[0, 0], [10, 0], [20, 0], [30, 0]]).data;
  data.deliveries.forEach((d, i) => { d.receivedAt = [500, 550, 540, 600][i]; d.reported.timeStamp = NaN; });
  const timeline = strokeTimeline(data);
  assert.deepEqual(timeline.times, [0, 50, 50, 100]);
  assert.equal(timeline.receiptFallbacks, 4);
  assert.equal(samplesAt(timeline.times, 50), 3);
  data.deliveries.forEach((d) => { d.receivedAt = NaN; });
  assert.equal(strokeTimeline(data).duration, 0);
  assert.equal(samplesAt(strokeTimeline(data).times, 0), 4);
  assert.equal(strokeTimeline({ deliveries: [] }).duration, 0);
  assert.equal(samplesAt([], 0), 0);
});
