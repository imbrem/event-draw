import type { PageTool } from './tool-picker.ts';

/** UI uses diameter; geometry and recorded eraser events keep page-unit radius. */
export class ThicknessControls {
  private width: HTMLInputElement;
  private size: HTMLInputElement;
  private events = new AbortController();
  constructor(private root: HTMLElement) {
    this.width = root.querySelector('#width')!;
    this.size = root.querySelector('#radius')!;
    for (const input of [this.width, this.size])
      input.addEventListener('input', () => this.render(), { signal: this.events.signal });
    this.render();
  }
  get radius() {
    return Number(this.size.value) / 2;
  }
  update(tool: PageTool, disabled: boolean) {
    const paint = ['pen', 'highlighter', 'restyle'].includes(tool);
    const touch = tool.startsWith('erase') || tool === 'restyle';
    this.root.hidden = !paint && !touch;
    this.root.querySelector<HTMLElement>('#width-control')!.hidden = !paint;
    this.root.querySelector<HTMLElement>('#eraser-control')!.hidden = !touch;
    this.root.querySelector('#width-label')!.textContent = tool === 'highlighter' ? 'Highlight' : 'Width';
    this.size.setAttribute('aria-label', tool === 'restyle' ? 'Touch size' : 'Eraser size');
    this.width.disabled = this.size.disabled = disabled;
    this.render();
  }
  private render() {
    for (const [input, id] of [
      [this.width, 'width'],
      [this.size, 'radius'],
    ] as const) {
      const value = Number(input.value);
      this.root.querySelector<HTMLOutputElement>('#' + id + '-value')!.value = String(value);
      this.root
        .querySelector<HTMLElement>('#' + id + '-preview')!
        .style.setProperty('--size', Math.min(24, value) + 'px');
      input.setAttribute('aria-valuetext', value + ' page units across');
      input.title =
        value +
        ' page units across' +
        (id === 'radius' ? ' (radius ' + this.radius + ')' : ' before pressure/speed processing');
    }
  }
  close() {
    this.events.abort();
  }
}
