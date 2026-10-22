import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Row, SqlDatabase } from './sql.ts';
export function sqliteAdapter(db: Database): SqlDatabase {
  return {
    exec(sql, bind) {
      db.exec(sql, bind ? { bind } : {});
    },
    all(sql, bind) {
      return db.selectObjects(sql, bind) as Row[];
    },
  };
}
