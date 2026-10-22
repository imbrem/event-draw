import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { ErasurePlanner, planErasure } from '../src/erasure.ts';
import { outputPoints, placeInk, remainingRanges } from '../src/geometry.ts';
import type { Point, VisibleShape } from '../src/model.ts';

// Optional historical geometry module, with imports resolved to this checkout.
// Without it, measure the old whole-prefix strategy with today's clip primitive.
const baseline = process.argv[2]
  ? ((await import(pathToFileURL(process.argv[2]).href)).planErasure as typeof planErasure)
  : (shapes: VisibleShape[], path: Point[], radius: number, whole: boolean) =>
      shapes.flatMap((shape) => {
        const points = placeInk(shape, outputPoints(shape));
        const kept = remainingRanges(
          points,
          [shape.start_index, shape.end_index],
          path,
          radius,
          points.map((p) => (p.widthFactor * shape.line_width) / 2),
        );
        return kept.length !== 1 || kept[0][0] !== shape.start_index || kept[0][1] !== shape.end_index
          ? [{ shape, ranges: whole ? [] : kept }]
          : [];
      });
const shapes = Array.from({ length: 160 }, (_, id) => ({
  id,
  output_version: 1,
  offset_x: (id % 10) * 80,
  offset_y: Math.floor(id / 10) * 30,
  scale: 1,
  rotation: 0,
  line_width: 3,
  start_index: 0,
  end_index: 24,
  output_json: JSON.stringify({
    points: Array.from({ length: 25 }, (_, i) => ({
      x: i * 3,
      y: Math.sin(i * 0.3) * 5,
      widthFactor: 0.5 + i / 24,
      sourceIndex: i,
    })),
  }),
})) as VisibleShape[];
const path = Array.from({ length: 1200 }, (_, i) => ({
  x: ((i % 120) / 119) * 820,
  y: Math.floor(i / 120) * 50,
}));
const frames = Array.from({ length: path.length / 12 }, (_, i) => (i + 1) * 12);
const time = (run: () => unknown) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};
function rounded(result: ReturnType<typeof planErasure>) {
  return result.map(({ shape, ranges }) => [shape.id, ranges.map((r) => r.map((n) => +n.toFixed(7)))]);
}
for (const whole of [false, true]) {
  planErasure(shapes, path.slice(0, 24), 8, whole); // warm up
  const batchMs = time(() => {
    for (const end of frames) baseline(shapes, path.slice(0, end), 8, whole);
  });
  let plan!: ErasurePlanner;
  const incrementalMs = time(() => {
    plan = new ErasurePlanner(shapes, 8, whole);
    for (const end of frames) plan.append(path.slice(end - 12, end));
  });
  assert.deepEqual(
    rounded(
      shapes.flatMap((shape) =>
        plan.ranges.has(shape.id) ? [{ shape, ranges: plan.ranges.get(shape.id)! }] : [],
      ),
    ),
    rounded(baseline(shapes, path, 8, whole)),
  );
  const commitMs = time(() => planErasure(shapes, path, 8, whole));
  console.log(
    JSON.stringify({
      tool: whole ? 'erase-strokes' : 'erase-parts',
      shapes: shapes.length,
      verticesPerShape: 25,
      eraserSamples: path.length,
      previewFrames: frames.length,
      batchPreviewMs: +batchMs.toFixed(1),
      incrementalPreviewMs: +incrementalMs.toFixed(1),
      speedup: +(batchMs / incrementalMs).toFixed(1),
      commitMs: +commitMs.toFixed(1),
    }),
  );
}
