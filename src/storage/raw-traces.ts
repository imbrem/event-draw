import { encode } from 'cborg';
import type { InkData } from '../model.ts';
import { tracePayloads } from '../trace-codecs.ts';
import type { Row } from './sql.ts';

/** Raw IDs are immutable, but imported notebooks may reuse local IDs. Compare
 * bytes before reusing the scene decode cache, rather than trusting the ID alone.
 */
export class RawTraces {
  private cache = new Map<
    number,
    { codec: string; version: number; size: number; bytes: Uint8Array; json: string }
  >();
  retain(ids: Set<number>) {
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }
  matches(row: Row, value: InkData): boolean {
    const a = encode(JSON.parse(this.json(row))),
      b = encode(value);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  json(row: Row): string {
    const id = Number(row.raw_stroke_id ?? row.id),
      bytes = row.data as Uint8Array,
      codec = String(row.data_codec);
    const cached = this.cache.get(id);
    if (
      cached?.codec === codec &&
      cached.version === row.data_version &&
      cached.size === row.decoded_bytes &&
      cached.bytes.length === bytes.length &&
      cached.bytes.every((v, i) => v === bytes[i])
    )
      return cached.json;
    if (row.data_version !== 1) throw new Error('Unsupported raw trace version: ' + row.data_version);
    const data = tracePayloads.unpack(row) as InkData,
      json = JSON.stringify(data);
    this.cache.set(id, {
      codec,
      version: Number(row.data_version),
      size: Number(row.decoded_bytes),
      bytes,
      json,
    });
    return json;
  }
}
