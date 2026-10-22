import { inkProcessors, policyJson, tryProcessInk, type InkResult, type InkPolicy, type InkProcessors } from '../ink.ts';
import type { InkData } from '../model.ts';
import { insertRow, scalar, type SqlDatabase } from './sql.ts';

export class InkStore {
  private db: SqlDatabase;
  private processors: InkProcessors;
  constructor(db: SqlDatabase, processors = inkProcessors) { this.db = db; this.processors = processors; }
  output(rawId: number, data: InkData, policy: InkPolicy): { id: number; policyId: number; output: InkResult } {
    const json = policyJson(policy);
    let policyId = this.db.all('SELECT id FROM ink_policies WHERE config_json = ?', [json])[0]?.id;
    if (policyId === undefined) {
      insertRow(this.db, 'ink_policies', { config_json: json }); policyId = scalar(this.db, 'SELECT last_insert_rowid()');
    }
    const existing = this.db.all('SELECT * FROM ink_outputs WHERE raw_stroke_id = ? AND policy_id = ?', [rawId, policyId])[0];
    if (existing) return { id: Number(existing.id), policyId: Number(policyId), output: { ...JSON.parse(String(existing.data_json)), rejected: existing.rejection_reason } };
    const output = tryProcessInk(data, policy, this.processors);
    insertRow(this.db, 'ink_outputs', { raw_stroke_id: rawId, policy_id: policyId, data_version: 1,
      rejection_reason: output.rejected, data_json: JSON.stringify({ kind: output.kind, points: output.points }) });
    return { id: scalar(this.db, 'SELECT last_insert_rowid()'), policyId: Number(policyId), output };
  }
}
