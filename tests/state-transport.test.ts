import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database, gesture } from './helpers.ts';
import { StateEncoder, StateDecoder } from '../src/state-transport.ts';
test('state deltas remove obsolete fragments and reuse unchanged capture entities', () => {
  const d = database();
  try {
    const encoder = new StateEncoder(),
      decoder = new StateDecoder();
    d.journal.gesture(
      gesture([
        [10, 20],
        [80, 20],
      ]),
      d.sessionId,
    );
    const first = decoder.decode(encoder.encode(d.journal.state()));
    d.journal.addPage(1, 1, 400, 300);
    const patch = encoder.encode(d.journal.state());
    assert.equal(patch.changes.shapes.upsert.length, 0);
    const second = decoder.decode(patch);
    assert.equal(second.shapes[0], first.shapes[0]);
    assert.deepEqual(second, d.journal.state());
    d.journal.clear(1);
    assert.deepEqual(decoder.decode(encoder.encode(d.journal.state())), d.journal.state());
    d.journal.undo(1);
    assert.deepEqual(decoder.decode(encoder.encode(d.journal.state())), d.journal.state());
  } finally {
    d.close();
  }
});
