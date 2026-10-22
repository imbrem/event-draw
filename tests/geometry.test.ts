import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lassoShapes, remainingRanges, slicePath } from '../src/geometry.ts';
import { database, gesture } from './helpers.ts';

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

test('lasso handles sparse crossings, enclosed taps, contact width, degenerate loops and fragments', () => {
  const d = database();
  try {
    d.journal.gesture(gesture([[0, 50], [100, 50]]), d.sessionId);
    d.journal.gesture(gesture([[50, 50]]), d.sessionId);
    d.journal.gesture(gesture([[0, 39.5], [100, 39.5]]), d.sessionId); // painted edge touches loop
    d.journal.gesture(gesture([[0, 38], [100, 38]]), d.sessionId);
    const polygon = [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }];
    assert.deepEqual(lassoShapes(d.journal.visible(), polygon).map((s) => s.id), [1, 2, 3]);
    assert.deepEqual(lassoShapes(d.journal.visible(), [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }]), []);
    d.journal.gesture(gesture([[50, 40], [50, 60]], 'erase-parts'), d.sessionId);
    const gap = [{ x: 48, y: 45 }, { x: 52, y: 45 }, { x: 52, y: 55 }, { x: 48, y: 55 }];
    assert.deepEqual(lassoShapes(d.journal.visible(), gap), []); // don't select erased geometry
  } finally { d.close(); }
});
