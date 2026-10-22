import '../src/node-trace-codecs.ts';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createNotebookExchange, type NotebookExchange } from '../src/storage/event-stream.ts';
import { validateNotebook } from '../src/storage/notebooks.ts';
import { verifyContent } from '../src/content.ts';
import type { Row, SqlDatabase } from '../src/storage/sql.ts';

// The adapter is trusted executable host code, just like a processor module.
const args = process.argv.slice(2);
const adapterIndex = args.indexOf('--adapter');
let adapterPath: string | undefined;
if (adapterIndex >= 0) {
  adapterPath = args[adapterIndex + 1];
  if (!adapterPath || adapterPath.startsWith('--')) throw new Error('--adapter requires a module path');
  args.splice(adapterIndex, 2);
}
const includeBlobs = !args.includes('--no-blobs');
const positional = args.filter((arg) => arg !== '--no-blobs');
const [command, input, output] = positional;
if (
  positional.length !== 3 ||
  !['export', 'replay'].includes(command) ||
  positional.some((s) => s.startsWith('--')) ||
  resolve(input) === resolve(output)
) {
  throw new Error(
    'Usage: pnpm events export|replay input output [--no-blobs] [--adapter ./trusted.ts] (a new output file)',
  );
}
if (command === 'replay' && !includeBlobs) throw new Error('--no-blobs applies to export only');
const exchange: NotebookExchange = adapterPath
  ? (await import(pathToFileURL(resolve(adapterPath)).href)).exchange
  : createNotebookExchange();
if (!exchange?.codec || typeof exchange.collect !== 'function' || typeof exchange.reconstruct !== 'function')
  throw new Error('Adapter must export a NotebookExchange named exchange');

function sql(db: DatabaseSync): SqlDatabase {
  return {
    exec(statement, bind) {
      if (bind) db.prepare(statement).run(...bind);
      else db.exec(statement);
    },
    all(statement, bind = []) {
      return db.prepare(statement).all(...bind) as Row[];
    },
  };
}
const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
const expected = new DatabaseSync(':memory:');
expected.exec(schema);
let file: number | undefined,
  database: DatabaseSync | undefined,
  created = false,
  success = false;
try {
  // Exclusive create: never overwrite the source or an existing output file.
  file = openSync(output, 'wx');
  created = true;
  if (command === 'export') {
    database = new DatabaseSync(input, { readOnly: true });
    validateNotebook(sql(database), sql(expected));
    for (const line of exchange.codec.encode(exchange.collect(sql(database), includeBlobs)))
      writeSync(file, line);
    closeSync(file);
    file = undefined;
    console.log('Exported ' + output);
  } else {
    closeSync(file);
    file = undefined;
    database = new DatabaseSync(output);
    database.exec(schema);
    const report = exchange.reconstruct(
      exchange.codec.decode(readFileSync(input, 'utf8').split('\n')),
      sql(database),
    );
    validateNotebook(sql(database), sql(expected));
    for (const row of sql(database).all('SELECT hash,data FROM blobs'))
      await verifyContent(String(row.hash), row.data as Uint8Array);
    console.log(JSON.stringify(report, null, 2));
  }
  success = true;
} finally {
  if (file !== undefined) closeSync(file);
  database?.close();
  expected.close();
  if (created && !success) unlinkSync(output);
}
