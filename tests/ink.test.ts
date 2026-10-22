import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture, note } from './helpers.ts';
import { createInkProcessors, DEFAULT_INK_POLICY, InkProcessors, policyJson, type InkPolicy } from '../src/ink.ts';
import { createInteractionPolicies } from '../src/interactions.ts';
import { Journal } from '../src/journal.ts';
import { shapeInk, shapePath, planErasure, lassoShapes, selectionBounds } from '../src/geometry.ts';

const smooth: InkPolicy = { ...DEFAULT_INK_POLICY, smoothing: { id: 'moving-average@1', options: {} } };

test('pressure adapts only pen measurements, falls back gracefully and retains pen-up width', () => {
  const data = gesture([[0, 0], [5, 20], [10, 0], [20, 0], [30, 0], [40, 0], [50, 0]]).data;
  const pressures = [0, 1, 0, null, NaN, 1.5, 0];
  data.deliveries.forEach((d, i) => Object.assign(d.reported, { pointerType: 'pen', buttons: i === 6 ? 0 : 1, pressure: pressures[i] }));
  const registry = createInkProcessors(), original = structuredClone(data);
  assert.deepEqual(registry.process(data, DEFAULT_INK_POLICY).points.map((p) => p.widthFactor), [.35, 1.65, .35, 1, 1, 1, 1]);
  data.deliveries.forEach((d) => { d.reported.pointerType = 'touch'; });
  assert.deepEqual(registry.process(data, DEFAULT_INK_POLICY).points.map((p) => p.widthFactor), pressures.map(() => 1));
  data.deliveries.forEach((d) => { d.reported.pointerType = 'pen'; });
  assert.deepEqual(data, original);
  assert.equal(policyJson({ ...smooth, smoothing: { id: 'moving-average@1', options: { z: 1, a: .5 } } }),
    policyJson({ ...smooth, smoothing: { id: 'moving-average@1', options: { a: .5, z: 1 } } }));
});

test('custom processors cannot alter raw observations or leak metadata into baked output', () => {
  const registry = createInkProcessors();
  registry.smoothers.set('experiment@sha256:abc', ({ samples }, options) => {
    samples[0].pressure = 1; options.amount = 99;
    return [{ x: 8, y: 9, sourceIndex: 0, color: 'red' }, { x: 12, y: 10, sourceIndex: 1 }];
  });
  const policy = { ...DEFAULT_INK_POLICY, smoothing: { id: 'experiment@sha256:abc', options: { amount: .5 } } };
  const data = gesture([[0, 0], [10, 0]]).data, original = structuredClone(data);
  const output = registry.process(data, policy);
  assert.deepEqual(data, original); assert.equal(policy.smoothing.options.amount, .5);
  assert.deepEqual(Object.keys(output.points[0]), ['x', 'y', 'sourceIndex', 'widthFactor']);
  assert.throws(() => registry.smoothers.set('experiment@sha256:abc', () => []), /already registered/);
});

test('malformed processors retain raw contact and persist a rejected output instead of failing a notebook write', () => {
  const registry = createInkProcessors();
  registry.smoothers.set('broken@1', () => [{ x: NaN, y: 0, sourceIndex: 0 }]);
  const d = database(registry);
  try {
    const input = gesture([[100, 200], [120, 220]]);
    input.policy = { ...DEFAULT_INK_POLICY, smoothing: { id: 'broken@1', options: {} } };
    const state = d.journal.gesture(input, d.sessionId);
    assert.equal(state.rawCount, 1); assert.equal(state.shapes.length, 0);
    assert.equal(d.db.all('SELECT kind FROM app_events')[0].kind, 'input.reject');
    assert.match(String(d.db.all('SELECT rejection_reason FROM ink_outputs')[0].rejection_reason), /invalid geometry/);
    assert.equal(JSON.parse(String(d.db.all('SELECT data_json FROM stroke_events')[0].data_json)).deliveries[1].reported.clientX, 120);
    input.policy = { ...DEFAULT_INK_POLICY, rejection: { id: 'pen-only@1', options: {} } };
    d.journal.gesture(input, d.sessionId);
    assert.equal(d.journal.state().rawCount, 2); assert.equal(d.journal.visible().length, 0);
    assert.deepEqual(d.db.all('PRAGMA foreign_key_check'), []);
  } finally { d.close(); }
});

test('group reprocessing preserves erased source intervals, placement, old outputs, undo and exact compact state', () => {
  const source = database(), target = database();
  try {
    source.journal.gesture(gesture([[100, 200], [125, 210], [150, 200], [175, 210], [200, 200]]), source.sessionId);
    source.journal.gesture(gesture([[150, 180], [150, 240]], 'erase-parts'), source.sessionId);
    const fragments = source.journal.visible(); assert.equal(fragments.length, 2);
    const move = gesture([[0, 0], [20, 40]], 'move-selection'); move.shapeIds = fragments.map((s) => s.id);
    source.journal.gesture(move, source.sessionId);
    const previous = source.journal.visible(), raw = source.db.all('SELECT * FROM stroke_events');
    source.journal.reprocess(1, previous.map((s) => s.id), smooth);
    const next = source.journal.visible(); assert.equal(next.length, 2);
    assert.notEqual(next[0].output_id, previous[0].output_id);
    assert.equal(next[0].output_id, next[1].output_id); // one result per trace/policy
    for (let i = 0; i < next.length; i++) {
      assert.equal(next[i].offset_x, previous[i].offset_x); assert.equal(next[i].offset_y, previous[i].offset_y);
      assert.equal(next[i].start_index, previous[i].start_index); assert.equal(next[i].end_index, previous[i].end_index);
      assert.equal(next[i].paint_order, previous[i].paint_order); assert.equal(next[i].style_id, previous[i].style_id);
    }
    assert.deepEqual(source.db.all('SELECT * FROM stroke_events'), raw);
    assert.equal(source.journal.outputs(1).length, 2);
    source.journal.setObject(note('**Kept** $x=5$'));
    target.db.exec('DELETE FROM capture_sessions'); source.journal.snapshotInto(target.db);
    assert.deepEqual(target.journal.visible(), next);
    assert.deepEqual(target.journal.state().objects, source.journal.state().objects);
    assert.equal(target.journal.outputs(1).length, 1); // only currently needed result
    assert.deepEqual(target.db.all('PRAGMA foreign_key_check'), []);
    // Baked rendering does not require the implementation that created it.
    const withoutPlugins = new InkProcessors();
    const reopened = new Journal(source.db, withoutPlugins);
    assert.deepEqual(reopened.visible(), next);
    reopened.reprocess(1, next.map((s) => s.id), smooth); // reuses the baked result
    assert.deepEqual(reopened.visible(), next);
    assert.ok(shapePath(next[0]).length); assert.throws(() => withoutPlugins.process(gesture([[0, 0]]).data, smooth), /Unknown/);
    source.journal.undo(1); // text
    source.journal.undo(1); // whole group, including both fragments
    assert.deepEqual(source.journal.visible(), previous);
  } finally { source.close(); target.close(); }
});

test('resampling a fragment maps fractional endpoints through raw sample correspondence', () => {
  const registry = createInkProcessors();
  registry.smoothers.set('endpoints@1', ({ samples }) => [0, samples.length - 1].map((sourceIndex) => ({ ...samples[sourceIndex], sourceIndex })));
  const d = database(registry);
  try {
    d.journal.gesture(gesture([[0, 50], [25, 50], [50, 50], [75, 50], [100, 50]]), d.sessionId);
    d.journal.gesture(gesture([[50, 40], [50, 60]], 'erase-parts'), d.sessionId);
    const old = d.journal.visible(), paths = old.map((s) => shapePath(s));
    d.journal.reprocess(1, old.map((s) => s.id), { ...DEFAULT_INK_POLICY, smoothing: { id: 'endpoints@1', options: {} } });
    assert.deepEqual(d.journal.visible().map((s) => shapePath(s)), paths.map((p) => [p[0], p.at(-1)]));
  } finally { d.close(); }
});

test('painted pressure radius participates in erasure, lasso, and selection bounds', () => {
  const d = database();
  try {
    const input = gesture([[0, 50], [100, 50]]); input.style.lineWidth = 20;
    input.data.deliveries.forEach((del, i) => Object.assign(del.reported, { pointerType: 'pen', pressure: i, buttons: 1 }));
    d.journal.gesture(input, d.sessionId);
    const shape = d.journal.visible()[0];
    assert.deepEqual(shapeInk(shape).map((p) => p.widthFactor), [.35, 1.65]);
    assert.equal(planErasure([shape], [{ x: 0, y: 60 }], 1, true).length, 0);
    assert.equal(planErasure([shape], [{ x: 100, y: 66 }], 1, true).length, 1);
    assert.deepEqual(selectionBounds([shape]), { x: -3.5, y: 33.5, width: 120, height: 33 });
    assert.equal(lassoShapes([shape], [{ x: 98, y: 65 }, { x: 102, y: 65 }, { x: 102, y: 67 }]).length, 1);
  } finally { d.close(); }
});

test('interaction plugins filter foreign targets and restyle preserves geometry identity with undo', () => {
  const interactions = createInteractionPolicies();
  interactions.lassos.set('custom@1', (shapes) => [shapes[0].id, shapes[0].id, 999]);
  interactions.touches.set('custom@1', ({ shapes, style }) => [{ shapeId: shapes[0].id, style }, { shapeId: 999, style }]);
  const d = database(undefined, interactions);
  try {
    d.journal.addPage(1, 1, 500, 500);
    d.journal.gesture(gesture([[0, 50], [100, 50]]), d.sessionId);
    d.journal.gesture(gesture([[0, 50], [100, 50]], 'pen', 2), d.sessionId);
    const original = d.journal.visible();
    const lasso = gesture([[0, 0]], 'lasso'); lasso.interaction = { id: 'custom@1', options: {} };
    d.journal.gesture(lasso, d.sessionId);
    assert.deepEqual(d.journal.related(d.journal.state().eventCount).map((r) => r.shape_id), [original[0].id]);
    const touch = gesture([[50, 0], [50, 100]], 'restyle');
    touch.interaction = { id: 'custom@1', options: {} }; touch.style = { color: '#ff0000', lineWidth: 8, opacity: .4 };
    d.journal.gesture(touch, d.sessionId);
    assert.equal(d.journal.visible(1)[0].color, '#ff0000');
    assert.equal(d.journal.visible(1)[0].id, original[0].id);
    assert.equal(d.journal.visible(1)[0].output_id, original[0].output_id);
    assert.deepEqual(d.journal.visible(2)[0], original[1]);
    d.journal.undo(1); assert.deepEqual(d.journal.visible(), original);
  } finally { d.close(); }
});

test('highlighter stores paint outside the raw trace and processing geometry', () => {
  const d = database();
  try {
    const input = gesture([[10, 20], [50, 30]], 'highlighter');
    input.style = { color: '#f3d44e', lineWidth: 24, opacity: .28 };
    d.journal.gesture(input, d.sessionId);
    const shape = d.journal.visible()[0]; assert.equal(shape.opacity, .28); assert.equal(shape.line_width, 24);
    const output = JSON.parse(shape.output_json); assert.deepEqual(Object.keys(output), ['kind', 'points']);
    assert.deepEqual(Object.keys(output.points[0]), ['x', 'y', 'sourceIndex', 'widthFactor']);
    assert.doesNotMatch(shape.data_json, /highlighter|opacity|color|lineWidth|policy/);
    assert.equal(d.db.all('SELECT tool FROM app_events')[0].tool, 'highlighter');
  } finally { d.close(); }
});

test('speed width and pressure/speed formula families remain configurable and preserve original observations', () => {
  const input = gesture([[0, 0], [10, 0], [20, 0], [120, 0]]), registry = createInkProcessors();
  input.data.deliveries.forEach((d, i) => Object.assign(d.reported, { timeStamp: i * 100, pressure: .8, pointerType: 'pen', buttons: 1 }));
  const original = structuredClone(input.data), process = (id: string, options: Record<string, number | string> = {}) => registry.process(input.data, { ...DEFAULT_INK_POLICY, pressure: { id, options } }).points.map((p) => p.widthFactor);
  const speed = process('speed-width@1'); assert.ok(speed[0] > speed.at(-1)!);
  const reverse = process('speed-width@1', { direction: 'thicker-fast' }); assert.ok(reverse[0] < reverse.at(-1)!);
  const onlyPressure = process('pressure-speed@1', { pressureWeight: 1, speedWeight: 0 });
  assert.ok(onlyPressure.every((p, i) => Math.abs(p - process('pen-pressure@1')[i]) < 1e-12));
  assert.deepEqual(process('pressure-speed@1', { pressureWeight: 0, speedWeight: 1 }), speed);
  const geometric = process('pressure-speed@1', { pressureWeight: 1, speedWeight: 1, mix: 'geometric' });
  assert.ok(Math.abs(geometric[0] - Math.sqrt(onlyPressure[0] * speed[0])) < 1e-10);
  assert.notDeepEqual(process('speed-width@1', { speedExponent: 2 }), speed);
  assert.deepEqual(input.data, original);
  input.data.deliveries.forEach((d) => { d.reported.timeStamp += 12345; });
  assert.deepEqual(process('speed-width@1'), speed); // speed is independent of clock origin
  input.data.deliveries.forEach((d) => { d.reported.timeStamp = 0; d.receivedAt = 0; d.reported.pressure = null; });
  assert.deepEqual(process('speed-width@1'), [1, 1, 1, 1]);
  assert.deepEqual(process('pressure-speed@1'), [1, 1, 1, 1]);
  input.data.deliveries.forEach((d, i) => { d.reported.timeStamp = NaN; d.receivedAt = i * 100; });
  assert.deepEqual(process('speed-width@1'), speed); // receipt clocks are usable fallback
});
