import type { Document } from '../model.ts';
import { element } from './shell.ts';

/** Renaming and choosing are replaceable presentation policies over stable IDs. */
export class DocumentControls {
  private id = 0;
  private key = '';
  private select = element<HTMLSelectElement>('document');
  private title = element<HTMLInputElement>('document-title');
  private name = element<HTMLInputElement>('document-name');
  constructor(choose: (id: number) => void, rename: (id: number, name: string) => void) {
    this.select.onchange = () => choose(Number(this.select.value));
    this.title.onchange = () => rename(this.id, this.title.value);
    this.title.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.title.blur();
      }
    };
    element('rename-document').onclick = () => rename(this.id, this.name.value);
  }
  update(documents: readonly Document[], id: number, disabled: boolean) {
    this.id = id;
    const current = documents.find((d) => d.id === id),
      key = id + ':' + current?.name;
    this.select.replaceChildren(
      ...documents.map((d) => new Option(d.name || 'Blank notes', String(d.id), false, d.id === id)),
    );
    element('document-choice').hidden = documents.length < 2;
    if (key !== this.key) {
      this.title.value = this.name.value = current?.name ?? '';
      this.key = key;
    }
    this.title.disabled = this.name.disabled = this.select.disabled = disabled;
  }
}
