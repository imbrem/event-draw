import type { CaptureSession, Delivery, Sample, ViewBox } from './model.ts';

export const PAGE_WIDTH = 1000;
export const PAGE_HEIGHT = 1200;

export function captureSession(): CaptureSession {
  return {
    startedAt: new Date().toISOString(),
    source: 'web-pointer-events',
    timeOriginMs: performance.timeOrigin,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    capabilities: {
      secureContext: window.isSecureContext,
      coalescedEvents: typeof PointerEvent.prototype.getCoalescedEvents === 'function',
      predictedEvents: typeof PointerEvent.prototype.getPredictedEvents === 'function',
      pointerrawupdate: 'onpointerrawupdate' in window,
      // API exposure only; these do not establish hardware measurement support.
      exposedFields: ['pressure', 'tangentialPressure', 'altitudeAngle', 'azimuthAngle',
        'tiltX', 'tiltY', 'twist', 'width', 'height', 'persistentDeviceId']
        .filter((field) => field in PointerEvent.prototype),
      pressureMeasurement: 'unknown',
      coordinateUnits: 'page units; original client/page/screen positions are CSS pixels',
      timeUnits: 'milliseconds relative to session time_origin_ms',
      angleUnits: 'tilt/twist degrees; altitude/azimuth radians',
    },
  };
}

/** Snapshot mutable/native-backed events before returning from the callback. */
export function captureDelivery(event: PointerEvent, canvas: HTMLCanvasElement,
  view: ViewBox = { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT }): Delivery {
  const receivedAt = performance.now();
  const rect = canvas.getBoundingClientRect();
  const scaleX = view.width / rect.width;
  const scaleY = view.height / rect.height;
  function sample(e: PointerEvent): Sample {
    const field = (name: string): number | null => {
      const value = (e as unknown as Record<string, unknown>)[name];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    return {
      x: view.x + (e.clientX - rect.left) * scaleX,
      y: view.y + (e.clientY - rect.top) * scaleY,
      timeStamp: e.timeStamp,
      pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
      clientX: e.clientX, clientY: e.clientY, pageX: e.pageX, pageY: e.pageY,
      screenX: e.screenX, screenY: e.screenY, button: e.button, buttons: e.buttons,
      pressure: field('pressure'), tangentialPressure: field('tangentialPressure'),
      width: field('width'), height: field('height'), tiltX: field('tiltX'), tiltY: field('tiltY'),
      twist: field('twist'), altitudeAngle: field('altitudeAngle'), azimuthAngle: field('azimuthAngle'),
      persistentDeviceId: field('persistentDeviceId'),
      movementX: field('movementX'), movementY: field('movementY'),
    };
  }
  // Preserve delivered, coalesced and predicted lists independently.
  // Unsupported methods and thrown platform errors degrade to empty lists.
  function optionalList(method: 'getCoalescedEvents' | 'getPredictedEvents'): Sample[] {
    try { return typeof event[method] === 'function' ? event[method]().map(sample) : []; }
    catch { return []; }
  }
  return {
    type: event.type, receivedAt,
    clientToPage: [scaleX, 0, 0, scaleY, view.x - rect.left * scaleX, view.y - rect.top * scaleY],
    reported: sample(event),
    coalesced: optionalList('getCoalescedEvents'),
    predicted: optionalList('getPredictedEvents'),
  };
}
