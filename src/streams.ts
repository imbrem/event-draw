/** Exchange IDs order this sequence only. Dependencies describe a record tree,
 * not a previous-event chain; a later commit/CID layer can replace these IDs. */
export interface StreamRecord {
  id: number;
  type: string;
  refs: number[];
  data: unknown;
}
export interface StreamCodec {
  encode(records: Iterable<StreamRecord>): Iterable<string>;
  decode(lines: Iterable<string>): Iterable<StreamRecord>;
}
export type RecordTransform = (records: Iterable<StreamRecord>) => Iterable<StreamRecord>;
/** Stages can filter, enrich or replace payloads without depending on SQLite. */
export function pipeRecords(
  records: Iterable<StreamRecord>,
  stages: readonly RecordTransform[] = [],
): Iterable<StreamRecord> {
  return stages.reduce((input, stage) => stage(input), records);
}
export const jsonlCodec: StreamCodec = {
  *encode(records) {
    for (const record of records) yield JSON.stringify(record) + '\n';
  },
  *decode(lines) {
    let previous = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as StreamRecord;
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        !('data' in record) ||
        !Number.isSafeInteger(record.id) ||
        record.id <= previous ||
        typeof record.type !== 'string' ||
        !Array.isArray(record.refs) ||
        record.refs.some((id) => !Number.isSafeInteger(id) || id < 1)
      )
        throw new Error('Invalid record or non-increasing stream ID');
      previous = record.id;
      yield record;
    }
  },
};
