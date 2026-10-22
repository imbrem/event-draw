import type { InkData, ViewBox } from '../model.ts';
import { samplesAt, strokeTimeline, type StrokeTimeline } from '../replay.ts';
import { drawPath, prepareCanvas } from './drawing.ts';

/** Read-only neutral preview/replay; never applies app style or changes SQLite. */
export class StrokePreview {
  private canvas = document.createElement('canvas');
  private timeline: StrokeTimeline;
  private view: ViewBox;
  private count: number;
  private frame = 0;
  private observer: ResizeObserver;
  private status = document.createElement('span');
  private stopButton = document.createElement('button');
  constructor(root: HTMLElement, data: InkData) {
    const timeline = this.timeline = strokeTimeline(data);
    this.count = timeline.points.length;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of timeline.points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if (!timeline.points.length) minX = minY = maxX = maxY = 0;
    const size = Math.max(maxX - minX, maxY - minY, 20), pad = size * 0.1;
    this.view = { x: minX - pad, y: minY - pad, width: size + 2 * pad, height: size + 2 * pad };
    this.canvas.className = 'raw-preview'; this.canvas.setAttribute('aria-label', 'Neutral raw stroke preview');
    const controls = document.createElement('div'); controls.className = 'replay-controls';
    const replay = document.createElement('button'), speed = document.createElement('select');
    replay.textContent = 'Replay stroke'; replay.disabled = !timeline.points.length;
    speed.setAttribute('aria-label', 'Replay speed');
    for (const value of [0.25, 1, 4]) speed.add(new Option(value + '×', String(value), false, value === 1));
    this.stopButton.textContent = 'Stop replay'; this.stopButton.disabled = true;
    replay.onclick = () => this.play(Number(speed.value));
    this.stopButton.onclick = () => this.stop();
    const summary = document.createElement('p'); summary.className = 'viewer-description';
    summary.textContent = timeline.points.length + ' measured samples · ' + timeline.duration.toFixed(1) + ' ms · ' +
      data.deliveries.length + ' deliveries · ' + data.deliveries.reduce((n, d) => n + d.predicted.length, 0) + ' predicted samples (excluded)' +
      (timeline.receiptFallbacks ? ' · ' + timeline.receiptFallbacks + ' receipt-time fallbacks' : '') +
      '. Uses sample timestamps; playback is limited by display refresh. Zero-duration captures appear instantly.';
    this.status.setAttribute('role', 'status'); this.status.className = 'replay-status';
    this.status.textContent = 'Full capture';
    controls.append(replay, this.stopButton, speed, this.status);
    root.append(this.canvas, controls, summary);
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(this.canvas);
    this.draw();
  }
  private draw() {
    if (!this.canvas.isConnected) return;
    const context = prepareCanvas(this.canvas, this.view);
    if (context) drawPath(context, this.timeline.points.slice(0, this.count), '#203b42', this.view.width / 150);
    this.canvas.dataset.replayedSamples = String(this.count);
  }
  private play(speed: number) {
    cancelAnimationFrame(this.frame);
    const started = performance.now();
    this.stopButton.disabled = false;
    const tick = () => {
      const elapsed = Math.min(this.timeline.duration, (performance.now() - started) * speed);
      this.count = samplesAt(this.timeline.times, elapsed); this.draw();
      if (elapsed < this.timeline.duration) {
        this.status.textContent = 'Replaying · ' + elapsed.toFixed(0) + ' / ' + this.timeline.duration.toFixed(0) + ' ms';
        this.frame = requestAnimationFrame(tick);
      } else {
        this.frame = 0; this.stopButton.disabled = true; this.status.textContent = 'Replay complete';
      }
    };
    tick();
  }
  stop() {
    cancelAnimationFrame(this.frame); this.frame = 0; this.stopButton.disabled = true;
    this.count = this.timeline.points.length; this.status.textContent = 'Full capture'; this.draw();
  }
  close() { cancelAnimationFrame(this.frame); this.observer.disconnect(); }
}
