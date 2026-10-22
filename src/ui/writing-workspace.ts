export type WorkspaceMode = 'auto' | 'notes' | 'page';

/** Host preferences only. Neither orientation nor toolbar layout changes notebook geometry. */
export class WritingWorkspace {
  private events = new AbortController();
  private tablet = matchMedia('(any-pointer: coarse)');
  private mode: WorkspaceMode = 'auto';
  private finger: boolean | undefined;
  constructor(
    private root: HTMLElement,
    private picker: HTMLSelectElement,
    private touch: HTMLInputElement,
    private changed: (notes: boolean) => void,
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem('event-draw-workspace') ?? 'null');
      if (['auto', 'notes', 'page'].includes(saved?.mode)) this.mode = saved.mode;
      if (typeof saved?.finger === 'boolean') this.finger = saved.finger;
    } catch {
      /* Preferences must not prevent opening a notebook. */
    }
    picker.value = this.mode;
    picker.addEventListener(
      'change',
      () => {
        this.mode = picker.value as WorkspaceMode;
        this.save();
        this.apply();
      },
      { signal: this.events.signal },
    );
    touch.addEventListener(
      'change',
      () => {
        this.finger = touch.checked;
        this.save();
      },
      { signal: this.events.signal },
    );
    this.tablet.addEventListener('change', () => this.apply(), { signal: this.events.signal });
    const viewport = window.visualViewport;
    const resize = () => {
      root.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
    };
    viewport?.addEventListener('resize', resize, { signal: this.events.signal });
    resize();
    this.apply();
  }
  get notes() {
    return this.mode === 'notes' || (this.mode === 'auto' && this.tablet.matches);
  }
  private apply() {
    this.root.dataset.workspace = this.notes ? 'notes' : 'page';
    this.touch.checked = this.finger ?? !this.notes;
    this.changed(this.notes);
  }
  private save() {
    try {
      localStorage.setItem('event-draw-workspace', JSON.stringify({ mode: this.mode, finger: this.finger }));
    } catch {
      /* Keep the current session usable without localStorage. */
    }
  }
  close() {
    this.events.abort();
  }
}
