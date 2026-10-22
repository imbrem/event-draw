import { encode, decode } from 'cborg';
import { PluginRegistry } from './plugins.ts';
import type { Row } from './storage/sql.ts';

export const MAX_TRACE_BYTES = 64 * 1024 * 1024;
export interface TraceCodec {
  encode(value: unknown): { data: Uint8Array; decodedBytes: number };
  decode(data: Uint8Array, decodedBytes: number): unknown;
}
export interface TraceCompression {
  compress(data: Uint8Array): Uint8Array;
  decompress(data: Uint8Array, decodedBytes: number): Uint8Array;
}
/** Frame content size is checked before the WASM decoder allocates its heap. */
export function zstdContentSize(data: Uint8Array): number | undefined {
  if (data.length < 6 || data[0] !== 0x28 || data[1] !== 0xb5 || data[2] !== 0x2f || data[3] !== 0xfd)
    throw new Error('Invalid zstd frame');
  const descriptor = data[4],
    single = Boolean(descriptor & 32),
    flag = descriptor >>> 6;
  if (descriptor & 8) throw new Error('Invalid zstd frame header');
  const offset = 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3];
  const length = [single ? 1 : 0, 2, 4, 8][flag];
  if (data.length < offset + length) throw new Error('Truncated zstd frame');
  if (!length) return undefined;
  let size = 0n;
  for (let i = 0; i < length; i++) size |= BigInt(data[offset + i]) << BigInt(8 * i);
  if (length === 2) size += 256n;
  if (size > BigInt(MAX_TRACE_BYTES)) throw new Error('Decoded trace exceeds size limit');
  return Number(size);
}
function checkLength(data: Uint8Array, expected: number) {
  if (data.length !== expected) throw new Error('Trace payload length mismatch');
  return data;
}
export function cborZstdCodec(compression: TraceCompression): TraceCodec {
  return {
    encode(value) {
      const bytes = encode(value);
      return { data: compression.compress(bytes), decodedBytes: bytes.length };
    },
    decode(data, size) {
      const frameSize = zstdContentSize(data);
      if (frameSize !== undefined && frameSize !== size) throw new Error('Trace frame length mismatch');
      return decode(checkLength(compression.decompress(data, size), size));
    },
  };
}
/** Encoding IDs identify wire formats, independent of data_version and processors.
 * Register decoders before opening a notebook; unsupported encodings fail explicitly.
 */
export class TracePayloads {
  readonly codecs = new PluginRegistry<TraceCodec>();
  writeCodec = 'cbor+zstd@1';
  constructor() {
    this.codecs.set('json@1', {
      encode: (value) => {
        const data = new TextEncoder().encode(JSON.stringify(value));
        return { data, decodedBytes: data.length };
      },
      decode: (data, size) =>
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checkLength(data, size))),
    });
    this.codecs.set('cbor@1', {
      encode: (value) => {
        const data = encode(value);
        return { data, decodedBytes: data.length };
      },
      decode: (data, size) => decode(checkLength(data, size)),
    });
  }
  pack(value: unknown, codec = this.writeCodec): Row {
    const result = this.get(codec).encode(value);
    this.checkSize(result.decodedBytes);
    if (result.data.length > MAX_TRACE_BYTES) throw new Error('Encoded trace exceeds size limit');
    return { data_codec: codec, data: result.data, decoded_bytes: result.decodedBytes };
  }
  unpack(row: Row): unknown {
    this.checkSize(Number(row.decoded_bytes));
    if (!(row.data instanceof Uint8Array) || row.data.length > MAX_TRACE_BYTES)
      throw new Error('Invalid trace bytes');
    return this.get(String(row.data_codec)).decode(row.data, Number(row.decoded_bytes));
  }
  private checkSize(size: number) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRACE_BYTES)
      throw new Error('Invalid decoded trace size');
  }
  private get(id: string) {
    const codec = this.codecs.get(id);
    if (!codec) throw new Error('Unsupported trace encoding: ' + id);
    return codec;
  }
}
export const tracePayloads = new TracePayloads();
