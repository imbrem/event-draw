import { boxDetectors, detectionTraces, sourceIdentity, type BoxDetectors } from '../detection.ts';
import type { DetectedBox, VisibleShape } from '../model.ts';
import { insertRow, scalar, type SqlDatabase } from './sql.ts';

export class DetectionStore {
  private db: SqlDatabase;
  private detectors: BoxDetectors;
  private event: (kind: string, pageId: number, cause: number, data: unknown) => number;
  constructor(db: SqlDatabase, event: DetectionStore['event'], detectors = boxDetectors) {
    this.db = db;
    this.event = event;
    this.detectors = detectors;
  }
  visible(): DetectedBox[] {
    return this.db.all('SELECT * FROM active_boxes ORDER BY id') as unknown as DetectedBox[];
  }
  reconcile(pageId: number, shapes: VisibleShape[], revision: number) {
    const traces = detectionTraces(shapes),
      inputKey = JSON.stringify(sourceIdentity(traces)),
      config = JSON.stringify(this.detectors.policy);
    this.db.exec('INSERT OR IGNORE INTO detector_policies (config_json) VALUES (?)', [config]);
    const policyId = scalar(this.db, 'SELECT id FROM detector_policies WHERE config_json = ?', [config]);
    const previous = this.db.all(
      'SELECT b.*, s.active FROM detected_boxes b JOIN latest_box_states s ON s.box_id = b.id WHERE b.page_id = ?',
      [pageId],
    );
    for (const box of previous) {
      const old = JSON.parse(String(box.source_key)) as { sources: number[][] };
      const ids = new Set(old.sources.map((s) => s[0]));
      const matches =
        box.policy_id === policyId &&
        JSON.stringify(sourceIdentity(traces.filter((t) => ids.has(t.shapeId)))) ===
          JSON.stringify(old.sources);
      if (matches === Boolean(box.active)) continue;
      const eventId = this.event(matches ? 'box.finish' : 'box.break', pageId, revision, {
        boxId: box.id,
        shapeIds: [...ids],
        reason: matches ? 'Constituent geometry restored' : 'Constituent geometry changed or disappeared',
      });
      insertRow(this.db, 'app_event_boxes', {
        app_event_id: eventId,
        box_id: box.id,
        active: matches ? 1 : 0,
      });
    }
    const last = this.db.all(
      'SELECT * FROM detection_runs WHERE page_id = ? AND policy_id = ? ORDER BY id DESC LIMIT 1',
      [pageId, policyId],
    )[0];
    if (last?.input_key === inputKey && last.status === 'ok') return;
    let candidates: ReturnType<BoxDetectors['run']> = [],
      error: string | null = null;
    try {
      candidates = this.detectors.run({ pageId, revision, traces });
    } catch (value) {
      error = String(value);
    }
    insertRow(this.db, 'detection_runs', {
      page_id: pageId,
      policy_id: policyId,
      input_event_id: revision || null,
      input_key: inputKey,
      status: error ? 'error' : 'ok',
      diagnostics_json: JSON.stringify({ error, candidates: candidates.length }),
    });
    const runId = scalar(this.db, 'SELECT last_insert_rowid()');
    for (const candidate of candidates) {
      const sourceKey = JSON.stringify({
        sources: sourceIdentity(traces.filter((t) => candidate.shapeIds.includes(t.shapeId))),
        region: [candidate.centerX, candidate.centerY, candidate.width, candidate.height, candidate.rotation],
      });
      let box = this.db.all(
        'SELECT id FROM detected_boxes WHERE page_id = ? AND policy_id = ? AND source_key = ?',
        [pageId, policyId, sourceKey],
      )[0];
      if (!box) {
        insertRow(this.db, 'detected_boxes', {
          page_id: pageId,
          policy_id: policyId,
          run_id: runId,
          source_key: sourceKey,
          center_x: candidate.centerX,
          center_y: candidate.centerY,
          width: candidate.width,
          height: candidate.height,
          rotation: candidate.rotation,
          confidence: candidate.confidence,
        });
        const id = scalar(this.db, 'SELECT last_insert_rowid()');
        box = { id };
        for (const shapeId of candidate.shapeIds)
          insertRow(this.db, 'box_shapes', { box_id: id, shape_id: shapeId });
      }
      if (
        this.db.all('SELECT box_id FROM latest_box_states WHERE box_id = ? AND active = 1', [box.id]).length
      )
        continue;
      const eventId = this.event('box.finish', pageId, revision, {
        boxId: box.id,
        shapeIds: candidate.shapeIds,
      });
      insertRow(this.db, 'app_event_boxes', { app_event_id: eventId, box_id: box.id, active: 1 });
    }
  }
}
