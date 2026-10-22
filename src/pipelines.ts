import type { ArtifactRef, TransformArtifact } from './transformations.ts';
import type { ContentId, ViewBox } from './model.ts';

/** Transport-neutral future worker/server boundary. A raster is content-addressed
 * and carries its pixel -> page transform, never an ambiguous screen screenshot.
 */
export type AnalysisInput = { kind: 'traces'; sources: ArtifactRef[] } | {
  kind: 'raster'; content: ContentId; mediaType: string; width: number; height: number;
  pixelToPage: [number, number, number, number, number, number];
  /** Reproducible recipe when this image was rendered from selected strokes. */
  recipe?: { sources: ArtifactRef[]; renderer: ContentId; bounds: ViewBox };
};
export interface AnalysisJob {
  requestId: string; implementation: ContentId; snapshotKey: string;
  inputs: AnalysisInput[]; parameters: unknown;
}
export interface AnalysisReply {
  requestId: string; snapshotKey: string; outputs: TransformArtifact[];
  regions?: { key: string; parentKey?: string; sourceRefs: ArtifactRef[];
    frame: [number, number, number, number, number, number]; width: number; height: number }[];
  diagnostics: unknown;
}
export interface AnalysisHost { run(job: AnalysisJob, signal?: AbortSignal): Promise<AnalysisReply> }
/** A stale reply may remain an immutable research result, but must not replace
 * current document detections without validating/rebasing its dependencies.
 */
export function replyIsCurrent(job: AnalysisJob, reply: AnalysisReply, currentSnapshot: string): boolean {
  return job.requestId === reply.requestId && job.snapshotKey === reply.snapshotKey && reply.snapshotKey === currentSnapshot;
}
/** Proposed sync envelope only. SQLite integer IDs remain database-local.
 * A sync host must remap references and define authoritative ordering or CRDT
 * semantics; sending these envelopes does not itself implement convergence.
 */
export interface OperationEnvelope {
  id: string; actor: string; sequence: number; parents: string[];
  document: string; payload: unknown;
}
