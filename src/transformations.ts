import type { ContentId } from './model.ts';

/** Contract for future multi-input recognition/fusion plugins. These semantic
 * artifacts are deliberately separate from the single-trace ink-path format.
 * Persistence/execution of these jobs is not implemented by the notebook yet.
 */
export interface ArtifactRef {
  kind: 'raw-trace' | 'ink-output' | 'semantic-artifact';
  id: number | ContentId;
  range?: [number, number];
  /** Local source coordinates -> common document coordinates. */
  placement?: [number, number, number, number, number, number];
}
export interface TransformRequest {
  /** Exact immutable code/model identity, e.g. a covalence CID of a WASM module. */
  implementation: ContentId;
  inputs: ArtifactRef[];
  parameters: unknown;
}
export interface TransformArtifact {
  /** e.g. ink-group, math/ast, math/latex, diagram/graph, proof/lean. */
  kind: string;
  schemaVersion: number;
  payload: unknown;
}
export interface TransformResult { outputs: TransformArtifact[]; diagnostics: unknown }
export interface TransformerHost {
  run(request: TransformRequest, signal?: AbortSignal): Promise<TransformResult>;
}
