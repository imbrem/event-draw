import { transaction, type SqlDatabase } from './sql.ts';

export const SCHEMA_VERSION = 3;
export function initializeSchema(db: SqlDatabase, schema: string): void {
  const version = Number(db.all('PRAGMA user_version')[0].user_version);
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new Error('Unsupported database schema version: ' + version +
      '. Export the existing database or reset local state.');
  }
  db.exec('PRAGMA foreign_keys = ON');
  transaction(db, () => db.exec(schema));
}
/** Explicit user-requested reset. No compatibility migration or silent clearing. */
export function resetSchema(db: SqlDatabase, schema: string): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      for (const type of ['view', 'table']) {
        for (const row of db.all("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%'", [type])) {
          const name = String(row.name).replaceAll('"', '""');
          db.exec('DROP ' + type.toUpperCase() + ' "' + name + '"');
        }
      }
      db.exec('PRAGMA user_version = 0');
      db.exec(schema);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
