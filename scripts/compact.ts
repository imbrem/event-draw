import '../src/node-trace-codecs.ts';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal, type Row, type SqlDatabase } from '../src/journal.ts';
import { requireSchemaIdentity } from '../src/storage/schema.ts';

const flags = new Set(process.argv.slice(2).filter((v) => v.startsWith('--')));
const [input, output] = process.argv.slice(2).filter((v) => !v.startsWith('--'));
if ([...flags].some((v) => !['--drawn', '--no-blobs'].includes(v))) throw new Error('Unknown export option');
if (!input || !output || resolve(input) === resolve(output)) {
  console.error(
    'Usage: pnpm compact input.sqlite3 output.sqlite3 [--drawn] [--no-blobs] (a new output file)',
  );
  process.exit(1);
}

function adapter(db: DatabaseSync): SqlDatabase {
  return {
    exec(sql, bind) {
      if (bind) db.prepare(sql).run(...bind);
      else db.exec(sql);
    },
    all(sql, bind = []) {
      return db.prepare(sql).all(...bind) as Row[];
    },
  };
}

const source = new DatabaseSync(input, { readOnly: true });
let target: DatabaseSync | undefined;
let created = false;
let success = false;
try {
  requireSchemaIdentity(adapter(source));
  // Exclusive create: never overwrite an existing database.
  closeSync(openSync(output, 'wx'));
  created = true;
  target = new DatabaseSync(output);
  target.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  const journal = new Journal(adapter(source));
  journal.snapshotInto(adapter(target), {
    drawnOnly: flags.has('--drawn'),
    includeBlobs: !flags.has('--no-blobs'),
  });
  if (
    target.prepare('PRAGMA foreign_key_check').all().length ||
    target.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok'
  ) {
    throw new Error('Output database integrity check failed');
  }
  console.log('Wrote ' + journal.visible().length + ' visible shapes to ' + output);
  success = true;
} finally {
  source.close();
  target?.close();
  if (created && !success) unlinkSync(output);
}
