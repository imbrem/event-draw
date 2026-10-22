import { measuredSamples, type InkData, type StrokeInput, type VisibleStroke } from './model.ts';
import { PAGE_HEIGHT, PAGE_WIDTH } from './capture.ts';

export function drawInk(context: CanvasRenderingContext2D, data: InkData, color: string, width: number) {
  const points = measuredSamples(data);
  if (!points.length) return;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke();
  // A tap is a dot, including platforms whose up/down coordinates are equal.
  context.beginPath();
  context.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
  context.fill();
}

export function render(canvas: HTMLCanvasElement, strokes: VisibleStroke[], pending: StrokeInput[]) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d')!;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(width / PAGE_WIDTH, 0, 0, height / PAGE_HEIGHT, 0, 0);
  for (const stroke of strokes) {
    // Preserve unknown shape kinds/versions in storage; skip unsupported rendering.
    if (stroke.kind === 'ink' && stroke.data_version === 1) {
      drawInk(context, JSON.parse(stroke.data_json) as InkData, stroke.color, stroke.width);
    }
  }
  for (const stroke of pending) drawInk(context, stroke.data, stroke.color, stroke.width);
}
