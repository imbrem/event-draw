import type { DetectedBox, PageObject, ViewBox } from '../model.ts';
import { renderContent } from './content-renderers.ts';

/** DOM content and oriented detection overlays share page coordinates with ink.
 * Renderers are independent of editing controls and content persistence.
 */
export class PageObjects {
  private loading: (void | Promise<void>)[] = [];
  private dragging = false;
  private root: HTMLElement;
  private paper: HTMLElement;
  private observer: ResizeObserver;
  private view: ViewBox = { x: 0, y: 0, width: 1, height: 1 };
  private objects: PageObject[] = [];
  private boxes: DetectedBox[] = [];
  private editing = false;
  private selectingSources = false;
  private key = '';
  private pick: (id: number) => void;
  private selectSources: (ids: number[]) => void;
  constructor(
    root: HTMLElement,
    paper: HTMLElement,
    pick: (id: number) => void,
    selectSources: (ids: number[]) => void,
    private move?: (
      id: number,
      placement: { x: number; y: number; width: number; height: number; rotation: number },
    ) => void,
  ) {
    this.root = root;
    this.paper = paper;
    this.pick = pick;
    this.selectSources = selectSources;
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(paper);
  }
  update(
    objects: PageObject[],
    boxes: DetectedBox[],
    view: ViewBox,
    editing: boolean,
    selectingSources: boolean,
  ) {
    const key = JSON.stringify([objects, boxes, editing, selectingSources]);
    this.view = view;
    if (this.key !== key && !this.dragging) {
      this.key = key;
      this.objects = objects;
      this.boxes = boxes;
      this.editing = editing;
      this.selectingSources = selectingSources;
      this.render();
    }
    this.layout();
  }
  private layout() {
    const rect = this.paper.getBoundingClientRect(),
      v = this.view;
    this.root.style.width = v.width + 'px';
    this.root.style.height = v.height + 'px';
    this.root.style.transform = `scale(${rect.width / v.width}, ${rect.height / v.height})`;
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-world-x]')) {
      node.style.left = Number(node.dataset.worldX) - v.x + 'px';
      node.style.top = Number(node.dataset.worldY) - v.y + 'px';
    }
  }
  private render() {
    this.loading = [];
    this.root.replaceChildren();
    for (const box of this.boxes) {
      const node = document.createElement('div');
      node.className = 'detected-box';
      node.dataset.boxId = String(box.id);
      node.dataset.worldX = String(box.center_x - box.width / 2);
      node.dataset.worldY = String(box.center_y - box.height / 2);
      node.style.width = box.width + 'px';
      node.style.height = box.height + 'px';
      node.style.transform = `rotate(${box.rotation}rad)`;
      const sourceIds = JSON.parse(box.shape_ids) as number[],
        label = document.createElement('button');
      label.textContent = 'Box #' + box.id + ' → ' + sourceIds.map((id) => 's' + id).join(', ');
      label.setAttribute('aria-label', 'Select strokes for box ' + box.id);
      label.onclick = () => this.selectSources(sourceIds);
      label.disabled = !this.selectingSources;
      label.style.pointerEvents = this.selectingSources ? 'auto' : 'none';
      label.title = 'Choose Lasso to select these constituent strokes';
      node.append(label);
      this.root.append(node);
    }
    for (const object of this.objects.filter((o) => o.rendered)) {
      const node = document.createElement('section');
      node.className = 'page-object';
      node.dataset.objectId = String(object.id);
      node.setAttribute('aria-label', object.label || 'Page object ' + object.id);
      node.dataset.worldX = String(object.x);
      node.dataset.worldY = String(object.y);
      node.style.width = object.width + 'px';
      node.style.height = object.height + 'px';
      node.style.transform = `rotate(${object.rotation}rad)`;
      const body = document.createElement('div');
      body.className = 'object-body markdown-preview';
      if (object.data_version === 1)
        this.loading.push(renderContent(object.format, JSON.parse(object.data_json), body));
      else body.textContent = 'Unsupported content version ' + object.data_version;
      node.append(body);
      if (this.editing) {
        node.classList.add('editing');
        const edit = document.createElement('button');
        edit.className = 'edit-page-object';
        edit.textContent = 'Edit ' + (object.label || '#' + object.id);
        edit.onclick = () => this.pick(object.id);
        node.append(edit);
        if (this.move)
          for (const action of ['Move', 'Resize', 'Rotate']) {
            const handle = document.createElement('button');
            handle.className = 'object-handle object-' + action.toLowerCase();
            handle.textContent = action;
            handle.setAttribute('aria-label', action + ' object ' + object.id);
            node.append(handle);
            handle.onpointerdown = (event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              this.dragging = true;
              handle.setPointerCapture(event.pointerId);
              const rect = this.paper.getBoundingClientRect(),
                sx = event.clientX,
                sy = event.clientY,
                ratio = this.view.width / rect.width;
              let placement = {
                x: object.x,
                y: object.y,
                width: object.width,
                height: object.height,
                rotation: object.rotation,
              };
              const move = (e: PointerEvent) => {
                if (e.pointerId !== event.pointerId) return;
                const dx = (e.clientX - sx) * ratio,
                  dy = (e.clientY - sy) * ratio;
                placement =
                  action === 'Move'
                    ? { ...placement, x: object.x + dx, y: object.y + dy }
                    : action === 'Resize'
                      ? {
                          ...placement,
                          width: Math.max(20, object.width + dx),
                          height: Math.max(20, object.height + dy),
                        }
                      : { ...placement, rotation: object.rotation + dx / 100 };
                node.style.left = placement.x - this.view.x + 'px';
                node.style.top = placement.y - this.view.y + 'px';
                node.style.width = placement.width + 'px';
                node.style.height = placement.height + 'px';
                node.style.transform = `rotate(${placement.rotation}rad)`;
              };
              const finish = (e: PointerEvent) => {
                if (e.pointerId !== event.pointerId) return;
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', finish);
                handle.removeEventListener('pointercancel', cancel);
                handle.removeEventListener('lostpointercapture', cancel);
                this.dragging = false;
                this.key = '';
                this.move!(object.id, placement);
              };
              const cancel = (e: PointerEvent) => {
                if (e.pointerId !== event.pointerId) return;
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', finish);
                handle.removeEventListener('pointercancel', cancel);
                handle.removeEventListener('lostpointercapture', cancel);
                this.dragging = false;
                this.render();
                this.layout();
              };
              handle.addEventListener('pointermove', move);
              handle.addEventListener('pointerup', finish);
              handle.addEventListener('pointercancel', cancel);
              handle.addEventListener('lostpointercapture', cancel);
            };
          }
      }
      this.root.append(node);
    }
  }
  async settled() {
    await Promise.all(this.loading);
  }
  close() {
    this.observer.disconnect();
  }
}
