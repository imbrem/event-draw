import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentCodec, contentCodecs } from '../src/content-codecs.ts';
import { compressionSizes } from '../scripts/stroke-compression.ts';
import { gesture } from './helpers.ts';

test('content source codecs retain literal text, custom formats are independently pluggable', () => {
  for (const format of ['text/plain', 'text/markdown', 'math/latex', 'image/svg+xml']) {
    const codec = contentCodec(format),
      source = '**literal** $x$\n<script>text</script>';
    assert.equal(codec.decode(codec.encode(source)), source);
  }
  assert.deepEqual(contentCodec('unknown/json').encode('{"marks":[1,2]}'), { marks: [1, 2] });
  assert.throws(() => contentCodec('unknown/json').encode('{'));
  contentCodecs.set('test/editor-format', {
    encode: (s) => ({ custom: s }),
    decode: (d) => (d as { custom: string }).custom,
  });
  assert.equal(contentCodec('test/editor-format').decode({ custom: 'hello' }), 'hello');
});
test('compression benchmark round-trips finite floats, missing fields and repeated observations', () => {
  const data = gesture([
    [Math.PI, 1 / 3],
    [99.12345678912345, 1e-100],
  ]).data;
  const per = compressionSizes([data, data], false),
    batch = compressionSizes([data, data], true);
  assert.ok(per.jsonZstd < per.json);
  assert.ok(per.cborZstd < per.cbor);
  assert.ok(batch.jsonZstd < per.jsonZstd);
  assert.ok(batch.cborZstd < per.cborZstd);
});
