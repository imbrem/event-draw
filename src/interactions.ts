import { lassoShapes, planErasure, shapePath, insidePolygon } from './geometry.ts';
import type { Algorithm } from './ink.ts';
import type { Point, Style, VisibleShape } from './model.ts';
import { PluginRegistry } from './plugins.ts';

export type LassoPolicy = (shapes: readonly VisibleShape[], loop: Point[], options: Algorithm['options']) => number[];
export interface TouchEdit { shapeId: number; style: Style }
export type TouchTransformer = (input: { shapes: VisibleShape[]; path: Point[]; radius: number; style: Style }, options: Algorithm['options']) => TouchEdit[];
export const DEFAULT_LASSO: Algorithm = { id: 'touch-or-enclose@1', options: {} };
export const DEFAULT_TOUCH: Algorithm = { id: 'restyle-touched@1', options: {} };

/** Interaction plugins produce declarative edits; the journal owns validation,
 * transactions and undo. They cannot write directly to SQLite.
 */
export class InteractionPolicies {
  readonly lassos = new PluginRegistry<LassoPolicy>();
  readonly touches = new PluginRegistry<TouchTransformer>();
  select(shapes: VisibleShape[], loop: Point[], spec = DEFAULT_LASSO): number[] {
    const plugin = this.lassos.get(spec.id);
    if (!plugin) throw new Error('Unknown lasso policy: ' + spec.id);
    const allowed = new Set(shapes.map((s) => s.id));
    return [...new Set(plugin(shapes, loop, spec.options))].filter((id) => allowed.has(id));
  }
  touch(input: Parameters<TouchTransformer>[0], spec = DEFAULT_TOUCH): TouchEdit[] {
    const plugin = this.touches.get(spec.id);
    if (!plugin) throw new Error('Unknown touch transformer: ' + spec.id);
    const allowed = new Set(input.shapes.map((s) => s.id));
    return plugin(input, spec.options).filter((edit) => allowed.has(edit.shapeId));
  }
}
export function createInteractionPolicies() {
  const registry = new InteractionPolicies();
  registry.lassos.set('touch-or-enclose@1', (shapes, loop) => lassoShapes([...shapes], loop).map((s) => s.id));
  // Deliberately a vertex test: sparse segments may leave a concave polygon.
  registry.lassos.set('vertices-inside@1', (shapes, loop) => loop.length < 3 ? [] : shapes.filter((s) => {
    const points = shapePath(s); return points.length > 0 && points.every((p) => insidePolygon(p, loop));
  }).map((s) => s.id));
  registry.touches.set('restyle-touched@1', ({ shapes, path, radius, style }) =>
    planErasure(shapes, path, radius, true).map(({ shape }) => ({ shapeId: shape.id, style })));
  return registry;
}
export const interactionPolicies = createInteractionPolicies();
