import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { adapter, schema, gesture } from './helpers.ts';
import { Journal } from '../src/journal.ts';

test('CLI snapshot preserves state and refuses to overwrite an existing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'event-draw-test-'));
  const input = join(directory, 'input.sqlite3'), output = join(directory, 'snapshot.sqlite3');
  try {
    const db = new DatabaseSync(input); db.exec(schema);
    const journal = new Journal(adapter(db));
    const session = journal.startSession({ startedAt: 'now', source: 'test', timeOriginMs: 0,
      userAgent: 'test', devicePixelRatio: 1, capabilities: {} });
    journal.gesture(gesture([[0, 0], [100, 0]]), session);
    journal.clear(1); journal.undo(1);
    const visible = journal.visible();
    db.close();
    const original = readFileSync(input);
    const script = new URL('../scripts/compact.ts', import.meta.url).pathname;
    const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, input, output]);
    const first = run();
    assert.equal(first.status, 0, first.stderr.toString());
    const snapshotBytes = readFileSync(output);
    const snapshot = new DatabaseSync(output, { readOnly: true });
    assert.deepEqual(new Journal(adapter(snapshot)).visible(), visible);
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM app_events').get()!.n, 1);
    snapshot.close();
    assert.notEqual(run().status, 0);
    assert.deepEqual(readFileSync(output), snapshotBytes);
    assert.deepEqual(readFileSync(input), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
