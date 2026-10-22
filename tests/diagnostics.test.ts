import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture } from './helpers.ts';

test('diagnostics distinguish visible ink captures, raw tool inputs and derived fragments', () => {
  const source = database(), compact = database();
  try {
    const empty = source.journal.diagnostics();
    assert.equal(empty.rawCaptures, 0); assert.equal(empty.assetBytes, 0);
    assert.equal(empty.activePages, 1); assert.equal(empty.documents, 1);
    source.journal.gesture(gesture([[0, 50], [100, 50]]), source.sessionId);
    source.journal.gesture(gesture([[0, 200], [100, 200]]), source.sessionId);
    source.journal.gesture(gesture([[50, 0], [50, 100]], 'erase-parts'), source.sessionId);
    source.journal.gesture(gesture([[50, 160], [50, 240]], 'erase-strokes'), source.sessionId);
    const cancelled = gesture([[20, 30]]); cancelled.cancelled = true;
    source.journal.gesture(cancelled, source.sessionId);
    const stats = source.journal.diagnostics();
    assert.equal(stats.rawCaptures, 5);
    assert.equal(stats.inkCaptures, 2);
    assert.equal(stats.visibleRawCaptures, 1);
    assert.equal(stats.shapes, 4);
    assert.equal(stats.visibleShapes, 2);
    assert.equal(stats.appEvents, 5);
    assert.equal(stats.rawBytes, source.db.all('SELECT data_json FROM stroke_events')
      .reduce((n, row) => n + new TextEncoder().encode(String(row.data_json)).length, 0));
    compact.db.exec('DELETE FROM capture_sessions'); source.journal.snapshotInto(compact.db);
    const current = compact.journal.diagnostics();
    assert.equal(current.visibleShapes, stats.visibleShapes);
    assert.equal(current.visibleRawCaptures, stats.visibleRawCaptures);
    assert.equal(current.rawCaptures, 1); assert.equal(current.inkCaptures, 1);
    assert.equal(current.appEvents, 1);
    source.journal.addPage(1, 1, 400, 500); source.journal.changePage(1, 'delete');
    assert.equal(source.journal.diagnostics().visibleRawCaptures, 0);
    assert.equal(source.journal.diagnostics().deletedPages, 1);
  } finally { source.close(); compact.close(); }
});
