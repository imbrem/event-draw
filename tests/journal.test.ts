import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture } from './helpers.ts';
import { shapePath } from '../src/geometry.ts';

test('raw capture is local and style/tool/page placement live in app records', () => {
  const d = database();
  try {
    d.journal.gesture(gesture([[100, 200], [200, 220]]), d.sessionId);
    const columns = d.db.all('PRAGMA table_info(stroke_events)').map((row) => row.name);
    assert.deepEqual(columns, ['id', 'capture_session_id', 'data_version', 'data_json']);
    const raw = JSON.parse(String(d.db.all('SELECT data_json FROM stroke_events')[0].data_json));
    assert.equal(raw.deliveries[0].reported.x, 0);
    assert.equal(raw.deliveries[0].reported.y, 0);
    assert.equal(raw.deliveries[1].reported.x, 100);
    assert.equal(raw.deliveries[0].reported.clientX, 100);
    assert.deepEqual(shapePath(d.journal.visible()[0]), [{ x: 100, y: 200 }, { x: 200, y: 220 }]);
    const event = d.db.all("SELECT * FROM app_events WHERE kind='stroke.add'")[0];
    assert.equal(event.tool, 'pen');
    assert.equal(event.page_id, 1);
    assert.equal(event.raw_stroke_id, 1);
    assert.equal(d.db.all('SELECT * FROM styles')[0].line_width, 2);
  } finally { d.close(); }
});

test('partial eraser creates ranges of the original capture and undo restores it', () => {
  const d = database();
  try {
    d.journal.gesture(gesture([[0, 50], [100, 50]]), d.sessionId);
    const original = d.db.all('SELECT * FROM stroke_events')[0];
    d.journal.gesture(gesture([[50, 0], [50, 100]], 'erase-parts'), d.sessionId);
    const fragments = d.journal.visible();
    assert.equal(fragments.length, 2);
    assert.deepEqual(fragments.map((s) => s.raw_stroke_id), [1, 1]);
    assert.equal(d.journal.state().rawCount, 2); // pen + real eraser gesture, not synthetic fragments
    assert.deepEqual(d.db.all('SELECT * FROM stroke_events WHERE id = 1')[0], original);
    assert.ok(fragments[0].end_index < 0.5);
    assert.ok(fragments[1].start_index > 0.5);
    d.journal.undo(1);
    assert.deepEqual(d.journal.visible().map((s) => s.id), [1]);
    d.journal.undo(1);
    assert.equal(d.journal.visible().length, 0);
  } finally { d.close(); }
});

test('whole-stroke erasing detects sparse crossings and is isolated to its page', () => {
  const d = database();
  try {
    d.journal.addPage(1, 1, 842, 595);
    d.journal.gesture(gesture([[0, 50], [100, 50]]), d.sessionId);
    d.journal.gesture(gesture([[0, 50], [100, 50]], 'pen', 2), d.sessionId);
    d.journal.gesture(gesture([[50, 0], [50, 100]], 'erase-strokes'), d.sessionId);
    assert.equal(d.journal.visible(1).length, 0);
    assert.equal(d.journal.visible(2).length, 1);
    assert.equal(d.journal.visible(2)[0].id, 2);
    d.journal.undo(1);
    assert.equal(d.journal.visible(1).length, 1);
    d.journal.clear(2);
    assert.equal(d.journal.visible(1).length, 1);
    assert.equal(d.journal.visible(2).length, 0);
    assert.deepEqual(d.db.all('PRAGMA foreign_key_check'), []);
  } finally { d.close(); }
});

test('cancelled inputs preserve captures but do not edit visible shapes or undo history', () => {
  const d = database();
  try {
    const input = gesture([[10, 20], [30, 40]]);
    input.cancelled = true;
    const state = d.journal.gesture(input, d.sessionId);
    assert.equal(state.rawCount, 1);
    assert.equal(state.eventCount, 3);
    assert.deepEqual(state.undoablePages, []);
    assert.deepEqual(state.shapes, []);
    assert.equal(d.db.all('SELECT kind FROM app_events ORDER BY id DESC LIMIT 1')[0].kind, 'input.cancel');
  } finally { d.close(); }
});

test('snapshot preserves pages, raw dependencies, fragments, style and placement with less history', () => {
  const source = database(), target = database();
  try {
    source.journal.addPage(1, 1, null, null);
    source.journal.gesture(gesture([[0, 50], [100, 50]]), source.sessionId);
    source.journal.gesture(gesture([[50, 0], [50, 100]], 'erase-parts'), source.sessionId);
    source.journal.gesture(gesture([[-200, -100], [400, 200]], 'pen', 2), source.sessionId);
    source.journal.clear(2);
    source.journal.undo(2);
    source.journal.snapshotInto(target.db);
    assert.deepEqual(source.journal.visible(), target.journal.visible());
    assert.deepEqual(source.journal.state().pages, target.journal.state().pages);
    assert.equal(target.journal.state().eventCount, 1);
    assert.equal(target.journal.state().rawCount, 2); // removes eraser capture, keeps ink dependencies
    assert.deepEqual(target.journal.state().undoablePages, []);
    assert.deepEqual(target.db.all('PRAGMA foreign_key_check'), []);
    assert.equal(target.db.all('PRAGMA integrity_check')[0].integrity_check, 'ok');
    target.journal.gesture(gesture([[0, 0], [10, 10]]), 1);
    target.journal.clear(1);
    target.journal.undo(1);
    assert.equal(target.journal.visible(1).length, 3);
  } finally { source.close(); target.close(); }
});

test('failed gesture rolls back raw, semantic and geometry records together', () => {
  const d = database();
  try {
    assert.throws(() => d.journal.gesture(gesture([[0, 0], [10, 10]]), 9999), /FOREIGN KEY/);
    assert.equal(d.journal.state().rawCount, 0);
    assert.equal(d.journal.state().eventCount, 2);
    assert.equal(d.journal.visible().length, 0);
  } finally { d.close(); }
});

test('database viewer is read only and restricts table names and pagination', () => {
  const d = database();
  try {
    d.journal.gesture(gesture([[0, 0], [10, 10]]), d.sessionId);
    assert.equal(d.journal.browse('stroke_events').total, 1);
    assert.equal(d.journal.related(3)[0].raw_stroke_id, 1);
    assert.throws(() => d.journal.browse('app_events; DROP TABLE pages' as never), /Unknown/);
    assert.throws(() => d.journal.browse('pages', -1), /pagination/);
    assert.equal(d.journal.browse('pages').total, 1);
  } finally { d.close(); }
});

test('lasso records references, move preserves raw identity, and delete/undo are page-local', () => {
  const d = database();
  try {
    d.journal.addPage(1, 1, 400, 400);
    d.journal.gesture(gesture([[0, 50], [100, 50]]), d.sessionId);
    d.journal.gesture(gesture([[10, 80]]), d.sessionId);
    d.journal.gesture(gesture([[0, 50], [100, 50]], 'pen', 2), d.sessionId);
    const original = d.journal.visible(1);
    const raw = d.db.all('SELECT * FROM stroke_events WHERE id = 1')[0];
    const lasso = gesture([[40, 40], [60, 40], [60, 60], [40, 60]], 'lasso');
    d.journal.gesture(lasso, d.sessionId);
    assert.deepEqual(d.journal.related(7).map((r) => r.shape_id), [1]);
    assert.deepEqual(d.journal.visible(1), original);
    const move = gesture([[50, 50], [70, 80]], 'move-selection');
    move.shapeIds = [1, 3, 999]; // foreign page / stale IDs cannot be edited
    d.journal.gesture(move, d.sessionId);
    const moved = d.journal.visible(1)[0];
    assert.equal(moved.id, original[0].id);
    assert.equal(moved.raw_stroke_id, original[0].raw_stroke_id);
    assert.equal(moved.offset_x, original[0].offset_x + 20);
    assert.equal(moved.offset_y, original[0].offset_y + 30);
    assert.deepEqual(d.db.all('SELECT * FROM stroke_events WHERE id = 1')[0], raw);
    assert.equal(d.journal.visible(2)[0].offset_x, 0);
    d.journal.deleteShapes(1, [1, 3]);
    assert.deepEqual(d.journal.visible(1).map((s) => s.id), [2]);
    assert.equal(d.journal.visible(2).length, 1);
    d.journal.undo(1);
    assert.deepEqual(d.journal.visible(1)[0], moved);
    d.journal.undo(1);
    assert.deepEqual(d.journal.visible(1), original);
    assert.deepEqual(d.db.all('PRAGMA foreign_key_check'), []);
  } finally { d.close(); }
});

test('compact moved fragments retain source bytes and discard selection/drag history', () => {
  const source = database(), target = database();
  try {
    source.journal.gesture(gesture([[0, 50], [100, 50]]), source.sessionId);
    source.journal.gesture(gesture([[50, 0], [50, 100]], 'erase-parts'), source.sessionId);
    const ids = source.journal.visible().map((s) => s.id);
    const move = gesture([[10, 50], [-90, -50]], 'move-selection');
    move.shapeIds = ids;
    source.journal.gesture(move, source.sessionId);
    source.journal.snapshotInto(target.db);
    assert.deepEqual(target.journal.visible(), source.journal.visible());
    assert.equal(target.journal.state().rawCount, 1);
    assert.equal(target.journal.state().eventCount, 1);
    assert.deepEqual(target.db.all('SELECT * FROM stroke_events'), source.db.all('SELECT * FROM stroke_events WHERE id = 1'));
    assert.equal(target.journal.visible()[0].offset_x, -100);
    assert.equal(target.journal.visible()[1].offset_x, -100);
  } finally { source.close(); target.close(); }
});
