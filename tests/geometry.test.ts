import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remainingRanges, slicePath } from '../src/geometry.ts';

test('partial erasing splits a long segment at exact fractional boundaries', () => {
  const result = remainingRanges([{ x: 0, y: 0 }, { x: 100, y: 0 }], [0, 1],
    [{ x: 50, y: -50 }, { x: 50, y: 50 }], 10);
  assert.deepEqual(result, [[0, 0.4], [0.6, 1]]);
});
test('a circular tap, repeated points, endpoints and full coverage are handled', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  assert.deepEqual(remainingRanges(points, [0, 1], [{ x: 0, y: 0 }], 10), [[0.1, 1]]);
  assert.deepEqual(remainingRanges(points, [0, 1], [{ x: 50, y: 0 }], 100), []);
  assert.deepEqual(remainingRanges([{ x: 1, y: 1 }], [0, 0], [{ x: 1, y: 1 }], 2), []);
  assert.deepEqual(remainingRanges(points, [0, 1], [{ x: 50, y: 50 }], 1), [[0, 1]]);
});
test('fractional fragment clipping interpolates endpoints without fabricating raw samples', () => {
  assert.deepEqual(slicePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 100 }], 0.5, 1.5),
    [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 150, y: 50 }]);
});
