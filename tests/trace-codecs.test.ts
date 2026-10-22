import '../src/node-trace-codecs.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { init, compress, decompress } from '@bokuweb/zstd-wasm';
import { TracePayloads, tracePayloads, cborZstdCodec, MAX_TRACE_BYTES } from '../src/trace-codecs.ts';
import { validateNotebook } from '../src/storage/notebooks.ts';
import { database, gesture } from './helpers.ts';

test('raw storage codecs preserve exact sensor data, mix per-row encodings and retain portable compressed events', () => {
  const d = database();
  const originalCodec = tracePayloads.writeCodec;
  try {
    const input = gesture([
      [Math.PI, 1 / 3],
      [20.12345678912345, 10.000000000000002],
    ]);
    input.data.deliveries[0].reported.pressure = null;
    for (const codec of ['cbor+zstd@1', 'cbor@1', 'json@1']) {
      tracePayloads.writeCodec = codec;
      d.journal.gesture(input, d.sessionId);
    }
    const rows = d.db.all('SELECT * FROM stroke_events');
    assert.deepEqual(
      rows.map((r) => r.data_codec),
      ['cbor+zstd@1', 'cbor@1', 'json@1'],
    );
    for (const row of rows) {
      assert.ok(row.data instanceof Uint8Array);
      assert.ok(!('data_json' in row));
      assert.deepEqual(tracePayloads.unpack(row), tracePayloads.unpack(rows[0]));
    }
    assert.ok((rows[0].data as Uint8Array).length < (rows[2].data as Uint8Array).length);
    assert.deepEqual(
      JSON.parse(d.journal.visible()[0].data_json),
      JSON.parse(d.journal.visible()[2].data_json),
    );
    validateNotebook(d.db, d.db);
    const registry = new TracePayloads();
    registry.codecs.set('test/custom@1', registry.codecs.get('json@1')!);
    assert.deepEqual(registry.unpack(registry.pack({ field: 1 }, 'test/custom@1')), { field: 1 });
    assert.throws(() => registry.unpack(rows[0]), /Unsupported trace encoding/);
    const row = rows[0];
    assert.throws(
      () => tracePayloads.unpack({ ...row, decoded_bytes: Number(row.decoded_bytes) + 1 }),
      /length mismatch/,
    );
    assert.throws(() => tracePayloads.unpack({ ...row, decoded_bytes: MAX_TRACE_BYTES + 1 }), /size/);
    assert.throws(() => tracePayloads.unpack({ ...row, data: new Uint8Array([1, 2, 3]) }), /zstd frame/);
    d.db.exec("UPDATE stroke_events SET data_codec='unknown@1' WHERE id=1");
    assert.throws(() => validateNotebook(d.db, d.db), /Unsupported trace encoding/);
  } finally {
    tracePayloads.writeCodec = originalCodec;
    d.close();
  }
});

test('WASM and Node zstd implementations decode each other without float quantization', async () => {
  await init();
  const wasm = cborZstdCodec({
    compress: (data) => compress(data, 3),
    decompress: (data, size) => decompress(data, { defaultHeapSize: size }),
  });
  const value = {
    samples: Array.from({ length: 1000 }, (_, i) => ({ x: i * Math.PI, pressure: i / 1001, absent: null })),
  };
  const native = tracePayloads.pack(value),
    encoded = wasm.encode(value);
  assert.deepEqual(wasm.decode(native.data as Uint8Array, Number(native.decoded_bytes)), value);
  assert.deepEqual(
    tracePayloads.unpack({
      data_codec: 'cbor+zstd@1',
      data: encoded.data,
      decoded_bytes: encoded.decodedBytes,
    }),
    value,
  );
});
