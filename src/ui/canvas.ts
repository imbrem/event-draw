import { captureDelivery } from '../capture.ts';
import { render, type Scene } from '../render.ts';
import type { Gesture, Point, Tool, ViewBox } from '../model.ts';

export interface CanvasOptions {
  canStart(): boolean;
  touchEnabled(): boolean;
  tool(): Tool;
  gesture(): Gesture;
  view(): ViewBox;
  scene(): Omit<Scene, 'active' | 'hover'>;
  onGesture(gesture: Gesture): void;
  onActive(active: boolean): void;
  onPan(view: ViewBox): void;
  moveTargets(point: Point): number[];
}
/** Pointer lifecycle and repaint scheduling; persistence/UI policy live elsewhere. */
export class NotebookCanvas {
  private active: { id: number; gesture: Gesture } | null = null;
  private pan: { id: number; x: number; y: number; view: ViewBox } | null = null;
  private hover: Point | null = null;
  private frame = 0;
  private events = new AbortController();
  private resize: ResizeObserver;
  private canvas: HTMLCanvasElement;
  private options: CanvasOptions;
  constructor(canvas: HTMLCanvasElement, options: CanvasOptions) {
    this.canvas = canvas;
    this.options = options;
    const listener = { signal: this.events.signal };
    canvas.addEventListener('pointerdown', (event) => this.start(event), listener);
    canvas.addEventListener('pointermove', (event) => this.move(event), listener);
    canvas.addEventListener('pointerrawupdate', (event) => this.record(event as PointerEvent), listener);
    canvas.addEventListener('pointerup', (event) => this.finish(event, false), listener);
    canvas.addEventListener('pointercancel', (event) => this.finish(event, true), listener);
    canvas.addEventListener('lostpointercapture', (event) => this.finish(event, true), listener);
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.repaint(); }, listener);
    this.resize = new ResizeObserver(() => this.repaint());
    this.resize.observe(canvas);
  }
  close() {
    this.events.abort();
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
  }
  private position(event: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect(), view = this.options.view();
    return { x: view.x + (event.clientX - rect.left) * view.width / rect.width,
      y: view.y + (event.clientY - rect.top) * view.height / rect.height };
  }
  private start(event: PointerEvent) {
    if (!this.options.canStart() || this.active || this.pan || event.button !== 0) return;
    if (event.pointerType === 'touch' && !this.options.touchEnabled()) return;
    if (this.options.tool() === 'pan') {
      this.pan = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...this.options.view() } };
    } else {
      const gesture = this.options.gesture();
      const targets = gesture.tool === 'lasso' ? this.options.moveTargets(this.position(event)) : [];
      if (targets.length) { gesture.tool = 'move-selection'; gesture.shapeIds = targets; }
      this.active = { id: event.pointerId, gesture };
      this.record(event);
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.options.onActive(true);
    this.repaint();
  }
  private record(event: PointerEvent) {
    if (this.active?.id !== event.pointerId) return;
    this.active.gesture.data.deliveries.push(captureDelivery(event, this.canvas, this.options.view()));
    this.repaint();
  }
  private move(event: PointerEvent) {
    this.hover = this.position(event);
    if (this.pan?.id === event.pointerId) {
      const rect = this.canvas.getBoundingClientRect(), pan = this.pan;
      this.options.onPan({ ...pan.view,
        x: pan.view.x - (event.clientX - pan.x) * pan.view.width / rect.width,
        y: pan.view.y - (event.clientY - pan.y) * pan.view.height / rect.height });
    } else this.record(event);
    this.repaint();
  }
  private finish(event: PointerEvent, cancelled: boolean) {
    if (this.pan?.id === event.pointerId) {
      this.pan = null;
      this.options.onActive(false);
    }
    if (this.active?.id !== event.pointerId) return;
    this.record(event);
    const gesture = this.active.gesture;
    gesture.cancelled = cancelled;
    this.active = null;
    this.options.onActive(false);
    this.options.onGesture(gesture);
    this.repaint();
  }
  repaint() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const scene = this.options.scene();
      this.canvas.style.cursor = scene.tool === 'pan' ? 'grab' :
        scene.tool.startsWith('erase') ? 'none' : 'crosshair';
      render(this.canvas, { ...scene, active: this.active?.gesture ?? null, hover: this.hover });
    });
  }
}
