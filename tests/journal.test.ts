import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Journal, type Row, type SqlDatabase } from '../src/journal.ts';
import type { StrokeInput } from '../src/model.ts';

const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');

function database() {
  const native = new DatabaseSync(':memory:');
  const db: SqlDatabase = {
    exec(sql, bind) {
      if (bind) native.prepare(sql).run(...bind);
      else native.exec(sql);
    },
    all(sql, bind = []) { return native.prepare(sql).all(...bind) as Row[]; },
  };
  db.exec(schema);
  const journal = new Journal(db);
  const sessionId = journal.startSession({
    startedAt: '2026-10-22T00:00:00Z', source: 'test', timeOriginMs: 123,
    userAgent: 'test', devicePixelRatio: 2, capabilities: { pressureMeasurement: 'unknown' },
  });
  return { db, journal, sessionId, close: () => native.close() };
}

const ink: StrokeInput = {
  kind: 'ink', dataVersion: 1, status: 'complete', color: '#123456', width: 3,
  data: { deliveries: [] },
};

test('add, clear and repeated undo replay through SQL without changing shapes', () => {
  const { db, journal, sessionId, close } = database();
  try {
    journal.addStroke(ink, sessionId);
    journal.addStroke(ink, sessionId);
    const shapes = db.all('SELECT * FROM stroke_events');
    assert.equal(journal.visible().length, 2);
    assert.equal(journal.clear().strokes.length, 0);
    assert.equal(journal.undo().strokes.length, 2);
    assert.equal(journal.undo().strokes.length, 1);
    assert.equal(journal.undo().strokes.length, 0);
    assert.equal(journal.undo().canUndo, false);
    assert.deepEqual(db.all('SELECT * FROM stroke_events'), shapes);
    assert.equal(db.all('PRAGMA foreign_key_check').length, 0);
  } finally { close(); }
});

test('cancelled strokes retain their capture and event reference but stay invisible', () => {
  const { db, journal, sessionId, close } = database();
  try {
    const state = journal.addStroke({ ...ink, status: 'cancelled' }, sessionId);
    assert.equal(state.shapeCount, 1);
    assert.equal(state.eventCount, 1);
    assert.equal(state.strokes.length, 0);
    assert.equal(state.canUndo, false);
    assert.equal(db.all('SELECT effect FROM app_event_strokes')[0].effect, 'hide');
  } finally { close(); }
});

test('one replace event can hide a shape and show multiple differently ordered fragments', () => {
  const { db, journal, sessionId, close } = database();
  try {
    journal.addStroke(ink, sessionId);
    journal.addStroke(ink, sessionId);
    journal.addStroke(ink, sessionId);
    db.exec("INSERT INTO app_events (occurred_at, kind, data_version, data_json) VALUES ('old-clock', 'shape.replace', 1, '{}')");
    db.exec("INSERT INTO app_event_strokes VALUES (4, 1, 'hide', NULL), (4, 2, 'show', 8), (4, 3, 'show', 5)");
    assert.deepEqual(journal.visible().map((s) => [s.id, s.paint_order]), [[3, 5], [2, 8]]);
    assert.throws(() => db.exec("INSERT INTO app_event_strokes VALUES (4, 999, 'show', 0)"), /FOREIGN KEY/);
    assert.throws(() => db.exec("INSERT INTO app_event_strokes VALUES (4, 1, 'show', 0)"), /UNIQUE/);
  } finally { close(); }
});

test('visible snapshot drops history, retains exact data/IDs/order, and remains editable', () => {
  const source = database();
  const target = database();
  try {
    source.journal.addStroke(ink, source.sessionId);
    source.journal.addStroke(ink, source.sessionId);
    source.journal.undo();
    source.journal.addStroke({ ...ink, color: '#abcdef' }, source.sessionId);
    // A fresh snapshot has no pre-existing capture sessions.
    target.db.exec('DELETE FROM capture_sessions');
    const before = source.db.all('SELECT * FROM app_events');
    source.journal.snapshotInto(target.db);
    assert.deepEqual(target.journal.visible(), source.journal.visible());
    assert.equal(target.journal.state().eventCount, 1);
    assert.equal(target.journal.state().shapeCount, 2);
    assert.equal(target.journal.state().canUndo, false);
    assert.deepEqual(source.db.all('SELECT * FROM app_events'), before);
    assert.equal(target.db.all('PRAGMA foreign_key_check').length, 0);
    assert.equal(target.db.all('PRAGMA integrity_check')[0].integrity_check, 'ok');
    const session = target.journal.startSession({
      startedAt: 'now', source: 'test', timeOriginMs: 0, userAgent: 'test',
      devicePixelRatio: 1, capabilities: {},
    });
    assert.equal(target.journal.addStroke(ink, session).strokes.at(-1)!.id, 4);
    target.journal.clear();
    assert.equal(target.journal.undo().strokes.length, 3);
  } finally { source.close(); target.close(); }
});

test('an empty visible snapshot stays empty and excludes irrelevant capture sessions', () => {
  const source = database();
  const target = database();
  try {
    source.journal.addStroke(ink, source.sessionId);
    source.journal.clear();
    target.db.exec('DELETE FROM capture_sessions');
    source.journal.snapshotInto(target.db);
    assert.deepEqual(target.journal.visible(), []);
    assert.equal(target.db.all('SELECT * FROM capture_sessions').length, 0);
    assert.equal(target.journal.state().shapeCount, 0);
  } finally { source.close(); target.close(); }
});

test('a failed write rolls back both the geometry and app event', () => {
  const { journal, close } = database();
  try {
    assert.throws(() => journal.addStroke(ink, 9999), /FOREIGN KEY/);
    assert.equal(journal.state().shapeCount, 0);
    assert.equal(journal.state().eventCount, 0);
  } finally { close(); }
});
