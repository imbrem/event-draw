import '../src/node-trace-codecs.ts';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Journal } from '../src/journal.ts';
import { BoxDetectors, createBoxDetectors, detectionTraces, type BoxDetector } from '../src/detection.ts';
import { requireSchemaIdentity } from '../src/storage/schema.ts';
import type { Row, SqlDatabase } from '../src/storage/sql.ts';

const [filename, modulePath] = process.argv.slice(2);
if (!filename) { console.error('Usage: pnpm detect notebook.sqlite3 [trusted-detector.mjs|.ts]'); process.exit(1); }
let detectors = createBoxDetectors();
if (modulePath) {
  const file = resolve(modulePath), id = 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
  const plugin = (await import(pathToFileURL(file).href)).default as BoxDetector;
  if (typeof plugin !== 'function') throw new Error('Detector module must default-export a function');
  detectors = new BoxDetectors({ id, options: {} }); detectors.scripts.set(id, plugin);
}
const native = new DatabaseSync(filename, { readOnly: true });
try {
  const db: SqlDatabase = { exec() { throw new Error('Evaluation is read only'); }, all(sql, bind = []) { return native.prepare(sql).all(...bind) as Row[]; } };
  requireSchemaIdentity(db);
  const journal = new Journal(db), state = journal.state();
  const pages = state.pages.map((p) => ({ pageId: p.id, candidates: detectors.run({ pageId: p.id, revision: state.eventCount, traces: detectionTraces(journal.visible(p.id)) }) }));
  console.log(JSON.stringify({ policy: detectors.policy, pages }, null, 2));
} finally { native.close(); }
