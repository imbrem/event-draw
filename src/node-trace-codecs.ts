/** Node host adapter. Browser hosts initialize the WASM adapter instead. */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { cborZstdCodec, tracePayloads } from './trace-codecs.ts';
tracePayloads.codecs.set(
  'cbor+zstd@1',
  cborZstdCodec({
    compress: (data) => zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
    decompress: (data, size) => zstdDecompressSync(data, { maxOutputLength: Math.max(1, size) }),
  }),
);
