import { transaction, type SqlDatabase } from './sql.ts';

export interface SchemaIdentity {
  uuid: string;
  version: string;
}
/** Fixed per schema family, never per notebook. Rotate uuid during incompatible
 * early experiments; published families can evolve via versioned importers.
 */
export const SCHEMA_IDENTITY: Readonly<SchemaIdentity> = Object.freeze({
  uuid: '7f0cfa452687929ea325a82a41333105813ba9c52d382f7e29d325216afe79ff',
  version: '0.0.0',
});
export function sameSchema(value: unknown, expected: Readonly<SchemaIdentity> = SCHEMA_IDENTITY): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uuid' in value &&
    'version' in value &&
    value.uuid === expected.uuid &&
    value.version === expected.version
  );
}
export function readSchemaIdentity(db: SqlDatabase): SchemaIdentity | undefined {
  if (!db.all("SELECT name FROM sqlite_schema WHERE type='table' AND name='schema_identity'").length)
    return undefined;
  const rows = db.all('SELECT uuid,version FROM schema_identity WHERE id=1');
  return rows.length === 1 ? { uuid: String(rows[0].uuid), version: String(rows[0].version) } : undefined;
}
export function requireSchemaIdentity(db: SqlDatabase): SchemaIdentity {
  const identity = readSchemaIdentity(db);
  if (!identity || !sameSchema(identity))
    throw new Error(
      'Unsupported notebook schema: ' +
        (identity ? identity.uuid + '@' + identity.version : 'missing UUID + version') +
        '. Export the existing database or reset local state.',
    );
  return identity;
}
export function initializeSchema(db: SqlDatabase, schema: string): void {
  const existing = db.all("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").length;
  if (existing) requireSchemaIdentity(db);
  db.exec('PRAGMA foreign_keys = ON');
  transaction(db, () => {
    db.exec(schema);
    requireSchemaIdentity(db);
  });
}
/** Explicit user-requested reset. No compatibility migration or silent clearing. */
export function resetSchema(db: SqlDatabase, schema: string): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      for (const type of ['view', 'table']) {
        for (const row of db.all(
          "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%'",
          [type],
        )) {
          const name = String(row.name).replaceAll('"', '""');
          db.exec('DROP ' + type.toUpperCase() + ' "' + name + '"');
        }
      }
      db.exec(schema);
      requireSchemaIdentity(db);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
