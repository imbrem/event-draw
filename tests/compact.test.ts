import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('CLI snapshot is readable, preserves state, and refuses to overwrite files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'event-draw-test-'));
  const input = join(directory, 'input.sqlite3');
  const output = join(directory, 'snapshot.sqlite3');
  try {
    const db = new DatabaseSync(input);
    db.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
    db.exec(`
      INSERT INTO stroke_events
        (id, page_id, created_at, kind, data_version, status, color, width, data_json)
        VALUES (8, 1, 'then', 'ink', 1, 'complete', '#123456', 3.0, '{"deliveries":[]}');
      INSERT INTO app_events (id, occurred_at, kind, data_version, data_json)
        VALUES (9, 'then', 'stroke.add', 1, '{}'),
               (10, 'then', 'irrelevant.action', 1, '{}');
      INSERT INTO app_event_strokes VALUES (9, 8, 'show', 42);
    `);
    db.close();
    const original = readFileSync(input);
    const script = new URL('../scripts/compact.ts', import.meta.url).pathname;
    const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, input, output]);
    assert.equal(run().status, 0);
    const snapshotBytes = readFileSync(output);
    const snapshot = new DatabaseSync(output, { readOnly: true });
    assert.equal(snapshot.prepare('SELECT id FROM visible_strokes').get()!.id, 8);
    assert.equal(snapshot.prepare('SELECT paint_order FROM visible_strokes').get()!.paint_order, 42);
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM app_events').get()!.n, 1);
    snapshot.close();
    assert.notEqual(run().status, 0);
    assert.deepEqual(readFileSync(output), snapshotBytes);
    assert.deepEqual(readFileSync(input), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
