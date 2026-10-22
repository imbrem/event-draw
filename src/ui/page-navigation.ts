import type { Page } from '../model.ts';

/** Navigation policy is independent of whether the UI uses buttons or scrolling. */
export class PageNavigation {
  private pages: Page[] = [];
  private id = 0;
  private disabled = true;
  private root: HTMLElement;
  private onSelect: (id: number) => void;
  constructor(root: HTMLElement, onSelect: (id: number) => void) {
    this.root = root; this.onSelect = onSelect;
    root.innerHTML = '<button id="previous-page" aria-label="Previous page">‹</button>' +
      '<label class="page-location"><input id="page-number" type="number" min="1" aria-label="Page number">' +
      '<span id="page-total"></span></label><button id="next-page" aria-label="Next page">›</button>';
    this.previous.onclick = () => this.step(-1);
    this.next.onclick = () => this.step(1);
    this.number.onchange = () => {
      const page = this.pages[Number(this.number.value) - 1];
      if (!this.disabled && page) this.onSelect(page.id);
      else this.number.value = String(this.index + 1);
    };
  }
  private get previous() { return this.root.querySelector<HTMLButtonElement>('#previous-page')!; }
  private get next() { return this.root.querySelector<HTMLButtonElement>('#next-page')!; }
  private get number() { return this.root.querySelector<HTMLInputElement>('#page-number')!; }
  private get index() { return this.pages.findIndex((p) => p.id === this.id); }
  private step(delta: number) {
    const page = this.pages[this.index + delta];
    if (!this.disabled && page) this.onSelect(page.id);
  }
  update(pages: Page[], id: number, disabled: boolean) {
    this.pages = pages; this.id = id; this.disabled = disabled;
    this.previous.disabled = disabled || this.index <= 0;
    this.next.disabled = disabled || this.index >= pages.length - 1;
    this.number.disabled = disabled || !pages.length;
    this.number.max = String(pages.length);
    this.number.value = this.index < 0 ? '' : String(this.index + 1);
    this.root.querySelector('#page-total')!.textContent = '/ ' + pages.length;
  }
}
