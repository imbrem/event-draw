import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/journal.ts';
import type { Gesture, Sample } from '../src/model.ts';
import type { Row, SqlDatabase } from '../src/storage/sql.ts';
import type { InkProcessors } from '../src/ink.ts';
import type { InteractionPolicies } from '../src/interactions.ts';

export const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
export function adapter(native: DatabaseSync): SqlDatabase {
  return {
    exec(sql, bind) { if (bind) native.prepare(sql).run(...bind); else native.exec(sql); },
    all(sql, bind = []) { return native.prepare(sql).all(...bind) as Row[]; },
  };
}
export function database(processors?: InkProcessors, interactions?: InteractionPolicies) {
  const native = new DatabaseSync(':memory:');
  const db = adapter(native);
  db.exec(schema);
  const journal = new Journal(db, processors, interactions);
  const sessionId = journal.startSession({
    startedAt: '2026-10-22T00:00:00Z', source: 'test', timeOriginMs: 123,
    userAgent: 'test', devicePixelRatio: 2, capabilities: { pressureMeasurement: 'unknown' },
  });
  return { db, journal, sessionId, close: () => native.close() };
}
export function gesture(points: [number, number][], tool: Gesture['tool'] = 'pen', pageId = 1): Gesture {
  return {
    pageId, tool, style: { color: '#123456', lineWidth: 2 }, radius: 8, cancelled: false,
    data: { deliveries: points.map(([x, y], index) => ({
      type: index === 0 ? 'pointerdown' : index === points.length - 1 ? 'pointerup' : 'pointermove',
      receivedAt: index, clientToPage: [1, 0, 0, 1, 0, 0],
      reported: { x, y, clientX: x, clientY: y, pressure: 0.5, timeStamp: index } as Sample,
      coalesced: [], predicted: [],
    })) },
  };
}
