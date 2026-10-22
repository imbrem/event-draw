import '../src/node-trace-codecs.ts';
import { tracePayloads } from '../src/trace-codecs.ts';
import { inkProcessors, DEFAULT_INK_POLICY } from '../src/ink.ts';
import type { Row } from '../src/storage/sql.ts';
import { DatabaseSync } from 'node:sqlite';
import type { InkData, Sample } from '../src/model.ts';
import { compressionSizes } from './stroke-compression.ts';

/** Deterministic synthetic pen observations using the capture schema. Not a
 * hardware corpus: real device precision, defaults and prediction rates differ.
 */
function synthetic(): InkData[] {
  let seed = 73;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: 64 }, (_, stroke) => {
    const samples: Sample[] = Array.from({ length: 120 }, (_, i) => {
      const x = 100 + i * 1.7 + random() * 0.3,
        y = 200 + 30 * Math.sin(i / 14) + random() * 0.3;
      return {
        x,
        y,
        timeStamp: stroke * 1500 + (i * 1000) / 240,
        pointerId: 1,
        pointerType: 'pen',
        isPrimary: true,
        clientX: x * 0.73,
        clientY: y * 0.73,
        pageX: x * 0.73,
        pageY: y * 0.73,
        screenX: x * 0.73 + 200,
        screenY: y * 0.73 + 100,
        button: i === 119 ? 0 : -1,
        buttons: i === 119 ? 0 : 1,
        pressure: i === 119 ? 0 : 0.5 + 0.2 * Math.sin(i / 16) + random() * 0.01,
        tangentialPressure: 0,
        width: 1,
        height: 1,
        tiltX: 20,
        tiltY: 10,
        twist: 0,
        altitudeAngle: 1.1 + random() * 0.001,
        azimuthAngle: 0.4 + random() * 0.001,
        persistentDeviceId: null,
        movementX: null,
        movementY: null,
      };
    });
    return {
      deliveries: Array.from({ length: 60 }, (_, i) => ({
        type: i === 0 ? 'pointerdown' : i === 59 ? 'pointerup' : 'pointermove',
        receivedAt: stroke * 1500 + (i * 1000) / 120 + random(),
        clientToPage: [1 / 0.73, 0, 0, 1 / 0.73, 0, 0],
        reported: samples[i * 2 + 1],
        coalesced: samples.slice(i * 2, i * 2 + 2),
        predicted:
          i === 59
            ? []
            : [
                {
                  ...samples[i * 2 + 1],
                  x: samples[i * 2 + 1].x + 2.1,
                  timeStamp: samples[i * 2 + 1].timeStamp + 8,
                },
              ],
      })),
    };
  });
}
const input = process.argv[2];
if (process.argv.length > 3 || input?.startsWith('--'))
  throw new Error('Usage: pnpm bench:strokes [notebook.sqlite3]');
let values: InkData[], outputs: unknown[];
if (input) {
  const db = new DatabaseSync(input, { readOnly: true });
  try {
    // Benchmark older JSON exports as well as current compressed notebooks.
    values = db
      .prepare('SELECT * FROM stroke_events ORDER BY id')
      .all()
      .map((row) =>
        typeof row.data_json === 'string' ? JSON.parse(row.data_json) : tracePayloads.unpack(row as Row),
      ) as InkData[];
    outputs = db
      .prepare('SELECT data_json FROM ink_outputs ORDER BY id')
      .all()
      .map((r) => JSON.parse(String(r.data_json)));
  } finally {
    db.close();
  }
} else {
  values = synthetic();
  outputs = values.map((data) => {
    const { kind, points } = inkProcessors.process(data, DEFAULT_INK_POLICY);
    return { kind, points };
  });
}
if (!values.length) throw new Error('No raw captures');
console.log(
  JSON.stringify(
    {
      corpus: input
        ? 'SQLite raw captures and stored processing outputs (read only)'
        : 'Synthetic pen corpus; not hardware recordings',
      zstdLevel: 3,
      cbor: 'cborg, exact numeric values; no record extensions',
      raw: {
        count: values.length,
        perCapture: compressionSizes(values, false),
        batch: compressionSizes(values, true),
      },
      processed: {
        count: outputs.length,
        perOutput: compressionSizes(outputs, false),
        batch: compressionSizes(outputs, true),
      },
      scope: 'Payload bytes only; no SQLite, codec metadata or index overhead. Each round-trip verified.',
    },
    null,
    2,
  ),
);
