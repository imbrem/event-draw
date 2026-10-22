import { captureDelivery } from '../capture.ts';
import { render, type Scene } from '../render.ts';
import type { Gesture, Point, Tool, ViewBox } from '../model.ts';

export interface CanvasOptions {
  canStart(): boolean;
  touchEnabled(): boolean;
  tool(): Tool | 'text';
  onText?(point: Point): void;
  gesture(tool: Gesture['tool']): Gesture;
  view(): ViewBox;
  scene(): Omit<Scene, 'active' | 'hover'>;
  onGesture(gesture: Gesture): void;
  onActive(active: boolean): void;
  onPan(view: ViewBox): void;
  onNavigate(dx: number, dy: number, scale: number, anchor: Point): void;
  moveTargets(point: Point): number[];
}
/** Pointer lifecycle and repaint scheduling; persistence/UI policy live elsewhere. */
export class NotebookCanvas {
  private active: { id: number; gesture: Gesture } | null = null;
  private pan: { id: number; x: number; y: number; view: ViewBox } | null = null;
  private touches = new Map<number, Point>();
  private pinch: { center: Point; distance: number } | null = null;
  private navigating = false;
  private lastPen = -Infinity;
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
    canvas.addEventListener(
      'pointerleave',
      () => {
        this.hover = null;
        this.repaint();
      },
      listener,
    );
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.options.canStart() || this.active) return;
        event.preventDefault();
        this.options.onNavigate(
          event.ctrlKey ? 0 : -event.deltaX,
          event.ctrlKey ? 0 : -event.deltaY,
          event.ctrlKey ? Math.exp(-event.deltaY * 0.01) : 1,
          { x: event.clientX, y: event.clientY },
        );
      },
      { ...listener, passive: false },
    );
    window.addEventListener('blur', () => this.interrupt(), listener);
    window.addEventListener('resize', () => this.interrupt(), listener);
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.interrupt();
      },
      listener,
    );
    this.resize = new ResizeObserver(() => this.repaint());
    this.resize.observe(canvas);
  }
  close() {
    this.events.abort();
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
  }
  private position(event: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect(),
      view = this.options.view();
    return {
      x: view.x + ((event.clientX - rect.left) * view.width) / rect.width,
      y: view.y + ((event.clientY - rect.top) * view.height) / rect.height,
    };
  }
  private cancelInk() {
    if (!this.active) return;
    const gesture = this.active.gesture;
    this.active = null;
    gesture.cancelled = true;
    this.options.onActive(false);
    this.options.onGesture(gesture);
    this.repaint();
  }
  private interrupt() {
    this.cancelInk();
    this.pan = null;
    this.touches.clear();
    this.pinch = null;
    this.navigating = false;
    this.options.onActive(false);
  }
  private touchMetric() {
    const points = [...this.touches.values()];
    if (points.length < 2) return null;
    return {
      center: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
      distance: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)),
    };
  }
  private start(event: PointerEvent) {
    if (event.button !== 0) return;
    if (this.options.tool() === 'text' && this.options.canStart() && !this.active) {
      event.preventDefault();
      this.options.onText?.(this.position(event));
      return;
    }
    if (event.pointerType === 'pen') {
      this.lastPen = performance.now();
      if (this.active?.gesture.data.deliveries[0]?.reported.pointerType === 'touch') this.cancelInk();
      this.touches.clear();
      this.pinch = null;
      this.pan = null;
      this.navigating = false;
    }
    if (event.pointerType === 'touch') {
      if (
        performance.now() - this.lastPen < 700 ||
        this.active?.gesture.data.deliveries[0]?.reported.pointerType === 'pen'
      )
        return;
      if (!this.options.canStart() && !this.touches.size) return;
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.canvas.setPointerCapture(event.pointerId);
      if (this.touches.size >= 2) {
        this.cancelInk();
        this.pan = null;
        this.navigating = true;
        this.pinch = this.touchMetric();
        this.options.onActive(true);
        return;
      }
      if (!this.options.touchEnabled()) {
        this.navigating = true;
        this.options.onActive(true);
        return;
      }
    }
    if (!this.options.canStart() || this.active || this.pan) return;
    const tool = this.options.tool();
    if (tool === 'text') return;
    if (tool === 'pan') {
      this.pan = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        view: { ...this.options.view() },
      };
    } else {
      const gesture = this.options.gesture(tool);
      const targets = gesture.tool === 'lasso' ? this.options.moveTargets(this.position(event)) : [];
      if (targets.length) {
        gesture.tool = 'move-selection';
        gesture.shapeIds = targets;
      }
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
    if (event.pointerType === 'touch' && this.touches.has(event.pointerId)) {
      const previous = this.touches.get(event.pointerId)!;
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.navigating) {
        const metric = this.touchMetric();
        if (metric && this.pinch)
          this.options.onNavigate(
            metric.center.x - this.pinch.center.x,
            metric.center.y - this.pinch.center.y,
            metric.distance / this.pinch.distance,
            metric.center,
          );
        else if (this.touches.size === 1 && !this.options.touchEnabled())
          this.options.onNavigate(event.clientX - previous.x, event.clientY - previous.y, 1, {
            x: event.clientX,
            y: event.clientY,
          });
        this.pinch = metric;
        return;
      }
    }
    if (this.pan?.id === event.pointerId) {
      const pan = this.pan;
      this.options.onNavigate(event.clientX - pan.x, event.clientY - pan.y, 1, {
        x: event.clientX,
        y: event.clientY,
      });
      pan.x = event.clientX;
      pan.y = event.clientY;
    } else this.record(event);
    this.repaint();
  }
  private finish(event: PointerEvent, cancelled: boolean) {
    if (event.pointerType === 'pen') this.lastPen = performance.now();
    if (this.touches.delete(event.pointerId) && this.navigating) {
      this.pinch = this.touchMetric();
      if (!this.touches.size) {
        this.navigating = false;
        this.options.onActive(false);
      }
      return;
    }
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
      this.canvas.style.cursor =
        scene.tool === 'pan' ? 'grab' : scene.tool.startsWith('erase') ? 'none' : 'crosshair';
      render(this.canvas, { ...scene, active: this.active?.gesture ?? null, hover: this.hover });
    });
  }
}
