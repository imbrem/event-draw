import type { InkData, ViewBox } from '../model.ts';
import { samplesAt, strokeTimeline, type StrokeTimeline } from '../replay.ts';
import { inkProcessors, type InkOutput, type InkPolicy } from '../ink.ts';
import type { Row } from '../storage/sql.ts';
import { drawInk, drawPath, prepareCanvas } from './drawing.ts';
import { InkControls } from './ink-controls.ts';
import { PlaybackControls } from './playback-controls.ts';

/** Comparison is read-only: previews do not create artifacts or edit the trace. */
export class StrokePreview {
  private canvas = document.createElement('canvas');
  private processedCanvas = document.createElement('canvas');
  private timeline: StrokeTimeline;
  private view: ViewBox = { x: 0, y: 0, width: 20, height: 20 };
  private count: number;
  private elapsed = Infinity;
  private output: InkOutput | undefined;
  private playback: PlaybackControls;
  private observer: ResizeObserver;
  private outputStatus = document.createElement('p');
  constructor(root: HTMLElement, data: InkData, outputs: Row[] = []) {
    root.classList.add('stroke-preview');
    const timeline = (this.timeline = strokeTimeline(data));
    this.count = timeline.points.length;
    this.canvas.className = this.processedCanvas.className = 'raw-preview';
    this.canvas.setAttribute('aria-label', 'Neutral raw stroke preview');
    this.processedCanvas.setAttribute('aria-label', 'Processed stroke preview');
    const comparison = document.createElement('div');
    comparison.className = 'raw-comparison';
    for (const [label, canvas] of [
      ['Original measurements', this.canvas],
      ['Processing output', this.processedCanvas],
    ] as const) {
      const figure = document.createElement('figure'),
        caption = document.createElement('figcaption');
      caption.textContent = label;
      figure.append(caption, canvas);
      comparison.append(figure);
    }
    const outputSelect = document.createElement('select');
    outputSelect.setAttribute('aria-label', 'Processing output');
    outputSelect.add(new Option('Choose a stored output', ''));
    for (const row of outputs) {
      const policy = JSON.parse(String(row.config_json)) as InkPolicy;
      outputSelect.add(
        new Option('#' + row.id + ' · ' + policy.smoothing.id + ' · ' + policy.pressure.id, String(row.id)),
      );
    }
    outputSelect.onchange = () => {
      const row = outputs.find((r) => String(r.id) === outputSelect.value);
      this.output = row?.data_version === 1 ? JSON.parse(String(row.data_json)) : undefined;
      this.outputStatus.textContent = String(
        row?.rejection_reason ??
          (this.output
            ? 'Stored output · complete trace in local coordinates'
            : 'No supported output selected'),
      );
      this.fit();
      this.stop();
    };
    const experiment = document.createElement('details'),
      summary = document.createElement('summary'),
      policyRoot = document.createElement('div');
    summary.textContent = 'Processor';
    experiment.className = 'processor-menu';
    const policies = new InkControls(policyRoot, 'preview-'),
      previewButton = document.createElement('button');
    previewButton.textContent = 'Preview policies';
    previewButton.onclick = () => {
      try {
        const result = inkProcessors.process(data, policies.value);
        this.output = result;
        outputSelect.value = '';
        this.outputStatus.textContent = result.rejected ?? 'Experimental preview · not saved';
        this.fit();
        this.stop();
      } catch (error) {
        this.outputStatus.textContent = String(error);
      }
    };
    experiment.append(summary, policyRoot, previewButton);
    const controls = document.createElement('div');
    this.playback = new PlaybackControls(
      controls,
      timeline.duration,
      Boolean(timeline.points.length),
      (state) => {
        this.elapsed = state.mode === 'stopped' ? Infinity : state.elapsed;
        this.count =
          state.mode === 'stopped' ? timeline.points.length : samplesAt(timeline.times, state.elapsed);
        this.draw();
      },
    );
    const description = document.createElement('p');
    description.className = 'viewer-description';
    description.textContent =
      timeline.points.length +
      ' measured samples · ' +
      timeline.duration.toFixed(1) +
      ' ms · ' +
      data.deliveries.length +
      ' deliveries · ' +
      data.deliveries.reduce((n, d) => n + d.predicted.length, 0) +
      ' predictions (excluded)' +
      (timeline.receiptFallbacks ? ' · ' + timeline.receiptFallbacks + ' receipt-time fallbacks' : '') +
      '. Both views use the original sample clock and common bounds. Neutral color/base width; fragment erasing and placement are not applied. Playback is display-frame limited.';
    this.outputStatus.className = 'output-status';
    experiment.insertBefore(outputSelect, policyRoot);
    experiment.insertBefore(this.outputStatus, policyRoot);
    root.append(comparison, controls, experiment, description);
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(this.canvas);
    this.observer.observe(this.processedCanvas);
    if (outputs.length) {
      outputSelect.value = String(outputs[0].id);
      outputSelect.onchange(new Event('change'));
    } else {
      this.fit();
      this.draw();
    }
  }
  private fit() {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const p of [...this.timeline.points, ...(this.output?.points ?? [])]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
    const size = Math.max(maxX - minX, maxY - minY, 20),
      pad = size * 0.1;
    this.view = { x: minX - pad, y: minY - pad, width: size + 2 * pad, height: size + 2 * pad };
  }
  private draw() {
    if (!this.canvas.isConnected) return;
    const context = prepareCanvas(this.canvas, this.view);
    if (context)
      drawPath(context, this.timeline.points.slice(0, this.count), '#203b42', this.view.width / 150);
    this.canvas.dataset.replayedSamples = String(this.count);
    const points = this.output?.points ?? [],
      times = this.timeline.times;
    const visible = points.filter((p) => {
      const i = Math.floor(p.sourceIndex),
        t = p.sourceIndex - i;
      const clock = times[i] + (times[Math.min(i + 1, times.length - 1)] - times[i]) * t;
      return clock <= this.elapsed;
    });
    const processed = prepareCanvas(this.processedCanvas, this.view);
    if (processed) drawInk(processed, visible, '#203b42', this.view.width / 150);
    this.processedCanvas.dataset.replayedSamples = String(visible.length);
  }
  stop() {
    this.playback.playback.stop();
  }
  close() {
    this.playback.close();
    this.observer.disconnect();
  }
}
