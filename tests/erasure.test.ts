import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErasurePlanner, planErasure } from '../src/erasure.ts';
import { outputPoints, placeInk, remainingRanges } from '../src/geometry.ts';
import { LiveEraser } from '../src/live-eraser.ts';
import { measuredSamples, type Point, type VisibleShape } from '../src/model.ts';
import { gesture } from './helpers.ts';

// The original whole-path implementation is deliberately independent of the
// incremental planner. Compare numeric boundaries, including fractional indices.
function batch(shapes: VisibleShape[], path: Point[], radius: number, whole: boolean) {
  return shapes.flatMap((shape) => {
    const points = placeInk(shape, outputPoints(shape));
    if (!points.length) return [];
    const ranges = remainingRanges(
      points,
      [shape.start_index, shape.end_index],
      path,
      radius,
      points.map((p) => (p.widthFactor * shape.line_width) / 2),
    );
    return ranges.length !== 1 || ranges[0][0] !== shape.start_index || ranges[0][1] !== shape.end_index
      ? [{ shape, ranges: whole ? [] : ranges }]
      : [];
  });
}
function compare(actual: ReturnType<typeof planErasure>, expected: ReturnType<typeof planErasure>) {
  assert.deepEqual(
    actual.map((e) => e.shape.id),
    expected.map((e) => e.shape.id),
  );
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].ranges.length, expected[i].ranges.length);
    actual[i].ranges.forEach((range, j) =>
      range.forEach((n, k) =>
        assert.ok(Math.abs(n - expected[i].ranges[j][k]) < 1e-7, `${n} != ${expected[i].ranges[j][k]}`),
      ),
    );
  }
}
function scene(): VisibleShape[] {
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: 24 }, (_, id) => {
    const points = Array.from({ length: id % 6 === 0 ? 1 : 12 }, (_, i) => ({
      x: i * 12,
      y: random() * 80,
      widthFactor: 0.2 + random() * 2,
      sourceIndex: i,
    }));
    return {
      id,
      output_version: 1,
      output_json: JSON.stringify({ points }),
      start_index: points.length === 1 ? 0 : 0.25,
      end_index: points.length - 1,
      offset_x: random() * 240 - 120,
      offset_y: random() * 240 - 120,
      scale: 0.3 + random() * 2,
      rotation: random() * Math.PI,
      line_width: 0.1 + random() * 20,
    } as VisibleShape;
  });
}

test('incremental erasing matches whole-path clipping for rotated variable-width fragments and dots', () => {
  const shapes = scene();
  const path = Array.from({ length: 80 }, (_, i) => ({
    x: Math.cos(i * 0.17) * 180,
    y: Math.sin(i * 0.3) * 180,
  }));
  path.splice(2, 0, path[1]); // repeated point
  for (const whole of [false, true]) {
    const plan = new ErasurePlanner(shapes, 6, whole);
    compare(planErasure(shapes, [], 6, whole), []);
    for (let i = 0; i < path.length; i++) {
      plan.append([path[i]]);
      const actual = shapes.flatMap((shape) =>
        plan.ranges.has(shape.id) ? [{ shape, ranges: plan.ranges.get(shape.id)! }] : [],
      );
      compare(actual, batch(shapes, path.slice(0, i + 1), 6, whole));
    }
    compare(planErasure(shapes, path, 6, whole), batch(shapes, path, 6, whole));
  }
});

test('live eraser rebuilds for raw arrival, replacement/truncated captures, scene and tool changes', () => {
  const shapes = scene();
  const input = gesture(
    [
      [-120, 40],
      [0, 20],
      [120, 40],
      [0, 80],
    ],
    'erase-parts',
  );
  input.data.deliveries[2].type = 'pointerrawupdate';
  input.data.deliveries[2].coalesced = [
    { ...input.data.deliveries[2].reported, x: 30 },
    input.data.deliveries[2].reported,
  ];
  input.data.deliveries[2].predicted = [{ ...input.data.deliveries[2].reported, x: -1000 }];
  const deliveries = input.data.deliveries;
  input.data = { deliveries: [] };
  const live = new LiveEraser();
  const check = (current = shapes) => {
    const result = live.update(input, current);
    compare(
      current.flatMap((shape) => (result.has(shape.id) ? [{ shape, ranges: result.get(shape.id)! }] : [])),
      batch(current, measuredSamples(input.data), input.radius, input.tool === 'erase-strokes'),
    );
    assert.equal(live.update(input, current), result);
    for (const [id, ranges] of result) assert.equal(live.update(input, current).get(id), ranges);
  };
  for (const delivery of deliveries) {
    input.data.deliveries.push(delivery);
    check();
  }
  input.radius = 20;
  check();
  input.tool = 'erase-strokes';
  check();
  check(shapes.map((s) => ({ ...s, offset_y: s.offset_y + 100 })));
  input.data.deliveries.splice(1);
  check();
  input.data = { deliveries: deliveries.slice() };
  check();
});

test('continuing an eraser does not reread old measured batches', () => {
  const input = gesture(
    [
      [0, 0],
      [30, 10],
      [60, 0],
    ],
    'erase-parts',
  );
  const deliveries = input.data.deliveries;
  let reads = 0;
  for (const delivery of deliveries) {
    const coalesced = delivery.coalesced;
    Object.defineProperty(delivery, 'coalesced', {
      get() {
        reads++;
        return coalesced;
      },
    });
  }
  input.data = { deliveries: [deliveries[0]] };
  const live = new LiveEraser(),
    shapes = scene();
  live.update(input, shapes);
  const initial = reads;
  for (let i = 0; i < 50; i++) live.update(input, shapes);
  assert.equal(reads, initial);
  input.data.deliveries.push(...deliveries.slice(1));
  live.update(input, shapes);
  assert.equal(reads - initial, 2); // only the two new, uncoalesced deliveries
});

test('broad-phase bounds retain the clip predicate tolerance even at zero width/radius', () => {
  const shape = {
    ...scene()[0],
    line_width: 0,
    scale: 1,
    rotation: 0,
    offset_x: 0,
    offset_y: 0,
    start_index: 0,
    end_index: 1,
    output_json: JSON.stringify({
      points: [
        { x: 0, y: 0, widthFactor: 1 },
        { x: 100, y: 0, widthFactor: 1 },
      ],
    }),
  };
  const path = [{ x: 50, y: 0.00005 }];
  const expected = batch([shape], path, 0, false);
  assert.equal(expected.length, 1);
  compare(planErasure([shape], path, 0, false), expected);
});
