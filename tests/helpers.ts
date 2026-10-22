import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/journal.ts';
import type { Gesture, Sample, ObjectInput } from '../src/model.ts';
import type { BoxDetectors } from '../src/detection.ts';
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
export function database(processors?: InkProcessors, interactions?: InteractionPolicies, detectors?: BoxDetectors) {
  const native = new DatabaseSync(':memory:');
  const db = adapter(native);
  db.exec(schema);
  const journal = new Journal(db, processors, interactions, detectors);
  const sessionId = journal.startSession({
    startedAt: '2026-10-22T00:00:00Z', source: 'test', timeOriginMs: 123,
    userAgent: 'test', devicePixelRatio: 2, capabilities: { pressureMeasurement: 'unknown' },
  });
  return { db, journal, sessionId, close: () => native.close() };
}
export function note(source: string, pageId = 1, id?: number, rendered = false): ObjectInput {
  return { id, pageId, rendered, format: 'text/markdown', data: { source }, x: 100, y: 100, width: 500, height: 200, rotation: 0, label: 'Note' };
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
