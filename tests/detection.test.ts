import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture, note } from './helpers.ts';
import { BoxDetectors, detectionTraces, createBoxDetectors } from '../src/detection.ts';
import { replyIsCurrent, type AnalysisJob, type AnalysisReply } from '../src/pipelines.ts';

const square: [number, number][] = [[100, 100], [300, 100], [300, 220], [100, 220], [100, 100]];
const rotate = (points: [number, number][], angle: number): [number, number][] => points.map(([x, y]) => [x * Math.cos(angle) - y * Math.sin(angle) + 300, x * Math.sin(angle) + y * Math.cos(angle) + 100]);

test('box script recognizes a closed rotated outline and keeps raw trace observations separate', () => {
  const d = database();
  try {
    d.journal.gesture(gesture(rotate(square, Math.PI / 6)), d.sessionId);
    const state = d.journal.state(); assert.equal(state.boxes.length, 1);
    const box = state.boxes[0]; assert.ok(Math.abs(box.rotation - Math.PI / 6) < 1e-8);
    assert.ok(Math.abs(box.width - 200) < 1e-8); assert.ok(Math.abs(box.height - 120) < 1e-8);
    assert.equal(box.shape_ids, '[1]');
    assert.deepEqual(d.db.all('SELECT kind, cause_event_id FROM app_events').map((r) => ({ ...r })), [
      { kind: 'stroke.add', cause_event_id: null }, { kind: 'box.finish', cause_event_id: 1 },
    ]);
    assert.equal(d.db.all('SELECT status FROM detection_runs')[0].status, 'ok');
    assert.doesNotMatch(String(d.db.all('SELECT data_json FROM stroke_events')[0].data_json), /box|detector|confidence/);
    const input = { pageId: 1, revision: 1, traces: detectionTraces(state.shapes) }, original = structuredClone(input);
    assert.equal(createBoxDetectors().run(input).length, 1); assert.deepEqual(input, original);
  } finally { d.close(); }
});

test('four constituent strokes finish a box; erasing even a small constituent part breaks it and undo restores its identity', () => {
  const d = database(), compact = database();
  try {
    for (let i = 0; i < 4; i++) d.journal.gesture(gesture([square[i], square[i + 1]]), d.sessionId);
    const initial = d.journal.state().boxes; assert.equal(initial.length, 1); assert.equal(initial[0].shape_ids, '[1,2,3,4]');
    d.journal.gesture(gesture([[200, 98], [200, 102]], 'erase-parts'), d.sessionId);
    assert.equal(d.journal.state().boxes.length, 0);
    assert.equal(d.db.all("SELECT count(*) AS n FROM app_events WHERE kind = 'box.break'")[0].n, 1);
    assert.equal(d.db.all('SELECT * FROM detected_boxes').length, 1);
    d.journal.undo(1); assert.deepEqual(d.journal.state().boxes, initial);
    compact.db.exec('DELETE FROM capture_sessions'); d.journal.snapshotInto(compact.db);
    assert.deepEqual(compact.journal.state().boxes, initial);
    assert.deepEqual(compact.journal.visible(), d.journal.visible());
    assert.deepEqual(compact.db.all('PRAGMA foreign_key_check'), []);
    assert.equal(compact.db.all('SELECT * FROM app_events').length, 1);
    compact.journal.deleteShapes(1, [1]); assert.equal(compact.journal.state().boxes.length, 0);
    compact.journal.undo(1); assert.equal(compact.journal.state().boxes[0].id, initial[0].id);
  } finally { d.close(); compact.close(); }
});

test('partial outlines, diagonal triangles and interior scribbles are rejected; nested boxes remain independent', () => {
  const d = database();
  try {
    d.journal.gesture(gesture(square.slice(0, 4)), d.sessionId); assert.equal(d.journal.state().boxes.length, 0);
    d.journal.gesture(gesture([[500, 100], [600, 100], [550, 200], [500, 100]]), d.sessionId); assert.equal(d.journal.state().boxes.length, 0);
    d.journal.gesture(gesture(square), d.sessionId);
    d.journal.gesture(gesture([[140, 130], [260, 130], [260, 190], [140, 190], [140, 130]]), d.sessionId);
    assert.equal(d.journal.state().boxes.length, 2);
    d.journal.gesture(gesture([[100, 100], [200, 170]]), d.sessionId); // does not invalidate unchanged inputs
    assert.equal(d.journal.state().boxes.length, 2);
  } finally { d.close(); }
});

test('moving and deleting constituent geometry updates detection state, while restyling leaves it unchanged', () => {
  const d = database();
  try {
    d.journal.gesture(gesture(square), d.sessionId); const first = d.journal.state().boxes[0];
    d.journal.gesture(gesture([[200, 80], [200, 120]], 'restyle'), d.sessionId);
    assert.deepEqual(d.journal.state().boxes, [first]);
    const move = gesture([[0, 0], [25, 50]], 'move-selection'); move.shapeIds = [1];
    d.journal.gesture(move, d.sessionId); const moved = d.journal.state().boxes[0];
    assert.notEqual(moved.id, first.id); assert.equal(moved.center_x, first.center_x + 25); assert.equal(moved.center_y, first.center_y + 50);
    d.journal.undo(1); assert.equal(d.journal.state().boxes[0].id, first.id);
    d.journal.addPage(1, 1, 500, 500); d.journal.changePage(1, 'delete');
    assert.equal(d.journal.state().boxes.length, 0);
    assert.equal(d.db.all('SELECT active FROM latest_box_states WHERE box_id = ?', [first.id])[0].active, 0);
  } finally { d.close(); }
});

test('foreign detector references and script failures are recorded without losing ink; new scripts use their own identity', () => {
  const detectors = new BoxDetectors({ id: 'experiment@2', options: { threshold: .8 } });
  detectors.scripts.set('experiment@2', () => [{ centerX: 0, centerY: 0, width: 50, height: 40, rotation: 0, confidence: 1, shapeIds: [999] }]);
  const d = database(undefined, undefined, detectors);
  try {
    d.journal.gesture(gesture(square), d.sessionId);
    assert.equal(d.journal.visible().length, 1); assert.equal(d.journal.state().rawCount, 1); assert.equal(d.journal.state().boxes.length, 0);
    const run = d.db.all('SELECT * FROM detection_runs')[0]; assert.equal(run.status, 'error'); assert.match(String(run.diagnostics_json), /foreign sources/);
    assert.match(String(d.db.all('SELECT config_json FROM detector_policies')[0].config_json), /experiment@2/);
  } finally { d.close(); }
});

test('compact detection provenance preserves all inputs from its run, including subsequently deleted unrelated traces', () => {
  const d = database(), compact = database();
  try {
    d.journal.gesture(gesture([[600, 600], [700, 700]]), d.sessionId);
    d.journal.gesture(gesture(square), d.sessionId);
    d.journal.deleteShapes(1, [1]);
    d.journal.setObject({ ...note('Recognized'), sourceShapeIds: [2] });
    compact.db.exec('DELETE FROM capture_sessions'); d.journal.snapshotInto(compact.db);
    assert.equal(compact.journal.state().rawCount, 2); assert.equal(compact.journal.visible().length, 1);
    assert.deepEqual(compact.journal.state().boxes, d.journal.state().boxes);
    assert.deepEqual(compact.db.all('PRAGMA foreign_key_check'), []);
  } finally { d.close(); compact.close(); }
});

test('async pipeline replies must match the request and current snapshot', () => {
  const job: AnalysisJob = { requestId: 'job1', implementation: 'sha256:code', snapshotKey: 'state1', inputs: [], parameters: {} };
  const reply: AnalysisReply = { requestId: 'job1', snapshotKey: 'state1', outputs: [], diagnostics: null };
  assert.equal(replyIsCurrent(job, reply, 'state1'), true);
  assert.equal(replyIsCurrent(job, reply, 'state2'), false);
  assert.equal(replyIsCurrent(job, { ...reply, requestId: 'job2' }, 'state1'), false);
});
