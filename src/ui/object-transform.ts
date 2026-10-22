import type { ObjectPlacement, ViewBox } from '../model.ts';

type Placement = Pick<ObjectPlacement, 'x' | 'y' | 'width' | 'height' | 'rotation'>;

/** One pointer transaction produces one placement event. Cancel restores bounds. */
export function dragObject(
  event: PointerEvent,
  target: HTMLElement,
  paper: HTMLElement,
  node: HTMLElement,
  initial: Placement,
  view: ViewBox,
  action: 'move' | 'resize' | 'rotate',
  finish: (placement?: Placement) => void,
) {
  event.preventDefault();
  event.stopPropagation();
  target.setPointerCapture(event.pointerId);
  const original = {
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    rotation: initial.rotation,
  };
  const rect = paper.getBoundingClientRect(),
    ratio = view.width / rect.width;
  const local = (e: PointerEvent) => ({
    x: view.x + (e.clientX - rect.left) * ratio,
    y: view.y + ((e.clientY - rect.top) * view.height) / rect.height,
  });
  const start = local(event),
    center = { x: original.x + original.width / 2, y: original.y + original.height / 2 };
  let placement = { ...original },
    moved = false;
  const draw = (p: Placement) => {
    node.style.left = p.x - view.x + 'px';
    node.style.top = p.y - view.y + 'px';
    node.style.width = p.width + 'px';
    node.style.height = p.height + 'px';
    node.style.transform = `rotate(${p.rotation}rad)`;
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    const point = local(e),
      dx = point.x - start.x,
      dy = point.y - start.y;
    if (Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 3 && !moved) return;
    moved = true;
    if (action === 'move') placement = { ...original, x: original.x + dx, y: original.y + dy };
    else if (action === 'rotate')
      placement = {
        ...original,
        rotation:
          original.rotation +
          Math.atan2(point.y - center.y, point.x - center.x) -
          Math.atan2(start.y - center.y, start.x - center.x),
      };
    else {
      // Anchor the opposite corner while resizing in the object's rotated axes.
      const c = Math.cos(original.rotation),
        s = Math.sin(original.rotation);
      const width = Math.max(20, original.width + c * dx + s * dy),
        height = Math.max(20, original.height - s * dx + c * dy);
      const dw = width - original.width,
        dh = height - original.height;
      placement = {
        ...original,
        width,
        height,
        x: original.x + (c * dw - s * dh - dw) / 2,
        y: original.y + (s * dw + c * dh - dh) / 2,
      };
    }
    draw(placement);
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    target.removeEventListener('lostpointercapture', end);
    const commit = e.type === 'pointerup' && moved;
    if (!commit) draw(original);
    finish(commit ? placement : undefined);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
  target.addEventListener('lostpointercapture', end);
}
