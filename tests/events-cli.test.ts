import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { adapter, schema, gesture } from './helpers.ts';
import { Journal } from '../src/journal.ts';
import { identifyContent } from '../src/content.ts';

test('CLI exchange round-trips with a trusted custom codec, verifies blobs and never overwrites files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'event-draw-events-'));
  const input = join(directory, 'input.sqlite3'),
    stream = join(directory, 'events.jsonl'),
    output = join(directory, 'output.sqlite3');
  const script = new URL('../scripts/events.ts', import.meta.url).pathname;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args]);
  try {
    const native = new DatabaseSync(input);
    native.exec(schema);
    const journal = new Journal(adapter(native));
    const sessionId = journal.startSession({
      startedAt: 'now',
      source: 'test',
      timeOriginMs: 0,
      userAgent: '',
      devicePixelRatio: 1,
      capabilities: {},
    });
    const bytes = new Uint8Array([1, 2, 3]);
    journal.importPdf({
      hash: await identifyContent(bytes),
      bytes,
      name: 'PDF',
      pages: [{ width: 100, height: 200 }],
    });
    journal.gesture(
      gesture(
        [
          [10, 10],
          [80, 50],
        ],
        'pen',
        2,
      ),
      sessionId,
    );
    const state = journal.state();
    native.close();
    const original = readFileSync(input);
    const module = join(directory, 'adapter.mjs');
    const factory = new URL('../src/storage/event-stream.ts', import.meta.url).href;
    writeFileSync(
      module,
      `import {createNotebookExchange} from ${JSON.stringify(factory)};
      const base = createNotebookExchange();
      export const exchange = {...base, codec: {
        *encode(records) { for (const line of base.codec.encode(records)) yield '@@' + line; },
        *decode(lines) { yield* base.codec.decode([...lines].filter(Boolean).map(line => line.slice(2))); }
      }};`,
    );
    for (const [command, from, to] of [
      ['export', input, stream],
      ['replay', stream, output],
    ]) {
      const result = run(command, from, to, '--adapter', module);
      assert.equal(result.status, 0, result.stderr.toString());
    }
    assert.match(readFileSync(stream, 'utf8'), /^@@/);
    const restored = new DatabaseSync(output, { readOnly: true });
    assert.deepEqual(new Journal(adapter(restored)).state(), state);
    restored.close();
    const saved = readFileSync(output);
    assert.notEqual(run('replay', stream, output, '--adapter', module).status, 0);
    assert.deepEqual(readFileSync(output), saved);
    assert.deepEqual(readFileSync(input), original);
    const corrupt = join(directory, 'corrupt.jsonl'),
      failed = join(directory, 'failed.sqlite3');
    assert.equal(run('export', input, corrupt).status, 0);
    const records = readFileSync(corrupt, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    records.find((r) => r.type === 'content.bytes').data.data.$bytes = 'BAUG';
    writeFileSync(corrupt, records.map((r) => JSON.stringify(r)).join('\n'));
    const result = run('replay', corrupt, failed);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /hash does not match/);
    assert.equal(existsSync(failed), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
