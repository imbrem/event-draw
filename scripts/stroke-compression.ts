import assert from 'node:assert/strict';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { encode, decode } from 'cborg';

export interface CompressionSizes {
  json: number;
  cbor: number;
  jsonZstd: number;
  cborZstd: number;
}
/** Benchmark only. No quantization, field deletion, schema changes or dictionaries. */
export function compressionSizes(values: unknown[], batch: boolean, level = 3): CompressionSizes {
  const sizes: CompressionSizes = { json: 0, cbor: 0, jsonZstd: 0, cborZstd: 0 };
  for (const value of batch ? [values] : values) {
    const json = Buffer.from(JSON.stringify(value)),
      cbor = encode(value);
    assert.deepEqual(decode(cbor), value);
    const compress = (bytes: Uint8Array) => {
      const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: level } });
      assert.deepEqual(zstdDecompressSync(compressed), Buffer.from(bytes));
      return compressed.length;
    };
    sizes.json += json.length;
    sizes.cbor += cbor.length;
    sizes.jsonZstd += compress(json);
    sizes.cborZstd += compress(cbor);
  }
  return sizes;
}
