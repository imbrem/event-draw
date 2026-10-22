import type { DetectedBox, PageObject, ViewBox } from '../model.ts';
import { renderContent } from './content-renderers.ts';
import { dragObject } from './object-transform.ts';

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
  private selectedId = 0;
  private inline?: { id: number; close: () => void };
  private nodes = new Map<number, HTMLElement>();
  private events = new AbortController();
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
    private editContent?: (id: number, root: HTMLElement, done: () => void) => () => void,
  ) {
    this.root = root;
    this.paper = paper;
    this.pick = pick;
    this.selectSources = selectSources;
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(paper);
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (
          this.inline &&
          event.target instanceof Node &&
          !this.nodes.get(this.inline.id)?.contains(event.target)
        )
          this.finishEditing();
      },
      { capture: true, signal: this.events.signal },
    );
  }
  update(
    objects: PageObject[],
    boxes: DetectedBox[],
    view: ViewBox,
    editing: boolean,
    selectingSources: boolean,
    selectedId = 0,
  ) {
    this.selectedId = selectedId;
    if (this.inline && (!objects.some((o) => o.id === this.inline!.id && o.rendered) || !editing))
      this.finishEditing();
    const key = JSON.stringify([objects, boxes, editing, selectingSources, selectedId]);
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
    for (const node of this.root.querySelectorAll('.detected-box')) node.remove();
    for (const [id, node] of this.nodes)
      if (!this.objects.some((o) => o.id === id && o.rendered)) {
        node.remove();
        this.nodes.delete(id);
      }
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
      const node = this.nodes.get(object.id) ?? document.createElement('section');
      this.nodes.set(object.id, node);
      node.className = 'page-object';
      node.dataset.objectId = String(object.id);
      node.setAttribute('aria-label', object.label || 'Page object ' + object.id);
      node.dataset.worldX = String(object.x);
      node.dataset.worldY = String(object.y);
      node.style.width = object.width + 'px';
      node.style.height = object.height + 'px';
      node.style.transform = `rotate(${object.rotation}rad)`;
      let body = node.querySelector<HTMLElement>('.object-body');
      if (!body) {
        body = document.createElement('div');
        body.className = 'object-body markdown-preview';
        node.append(body);
      }
      if (this.inline?.id !== object.id && body.dataset.content !== object.format + object.data_json) {
        body.dataset.content = object.format + object.data_json;
        body.replaceChildren();
        if (object.data_version === 1)
          this.loading.push(renderContent(object.format, JSON.parse(object.data_json), body));
        else body.textContent = 'Unsupported content version ' + object.data_version;
      }
      node.classList.toggle('editing', this.editing);
      node.classList.toggle('selected', this.editing && object.id === this.selectedId);
      node.classList.toggle('typing', this.inline?.id === object.id);
      node.tabIndex = this.editing ? 0 : -1;
      node.title = this.editing ? 'Drag to move. Double-click or press Enter to type.' : '';
      node.onpointerdown = (event) => {
        if (!this.editing || event.button !== 0 || this.inline?.id === object.id) return;
        this.dragging = true;
        this.pick(object.id);
        if (this.move)
          dragObject(event, node, this.paper, node, object, this.view, 'move', (placement) => {
            this.dragging = false;
            this.key = '';
            if (placement) this.move!(object.id, placement);
            else {
              this.render();
              this.layout();
            }
          });
        else this.dragging = false;
      };
      node.ondblclick = (event) => {
        if (this.editing) {
          event.preventDefault();
          this.edit(object.id);
        }
      };
      node.onkeydown = (event) => {
        if (event.target === node && event.key === 'Enter') {
          event.preventDefault();
          this.edit(object.id);
        }
      };
      for (const handle of node.querySelectorAll('.object-handle')) handle.remove();
      if (this.editing && object.id === this.selectedId && this.inline?.id !== object.id && this.move) {
        for (const action of ['resize', 'rotate'] as const) {
          const handle = document.createElement('button');
          handle.className = 'object-handle object-' + action;
          handle.setAttribute(
            'aria-label',
            (action === 'resize' ? 'Resize' : 'Rotate') + ' object ' + object.id,
          );
          handle.title = action === 'resize' ? 'Resize' : 'Rotate';
          handle.onpointerdown = (event) => {
            if (event.button !== 0) return;
            this.dragging = true;
            dragObject(event, handle, this.paper, node, object, this.view, action, (placement) => {
              this.dragging = false;
              this.key = '';
              if (placement) this.move!(object.id, placement);
              else {
                this.render();
                this.layout();
              }
            });
          };
          node.append(handle);
        }
      }
      if (!node.isConnected) this.root.append(node);
    }
  }
  edit(id: number) {
    this.finishEditing();
    const node = this.nodes.get(id),
      object = this.objects.find((o) => o.id === id);
    if (!node || !object || !this.editContent) return;
    const body = node.querySelector<HTMLElement>('.object-body')!;
    body.replaceChildren();
    delete body.dataset.content;
    // Install the sentinel before mount: selecting an object can synchronously refresh UI.
    this.inline = { id, close: () => {} };
    this.inline.close = this.editContent(id, body, () => this.finishEditing());
    node.classList.add('typing');
  }
  finishEditing() {
    if (!this.inline) return;
    const inline = this.inline;
    this.inline = undefined;
    inline.close();
    this.key = '';
    this.render();
    this.layout();
  }

  async settled() {
    await Promise.all(this.loading);
  }
  close() {
    this.events.abort();
    this.inline?.close();
    this.observer.disconnect();
  }
}
