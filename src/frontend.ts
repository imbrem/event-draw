import type { BlankPageLayout } from './note-pages.ts';
import type { State, Gesture, PageSource, ObjectInput, SelectionTransform, ClipboardInk } from './model.ts';
import type { InkPolicy } from './ink.ts';

/** A small, data-only boundary for trusted UI experiments and future WASM hosts. */
export const EDIT_COMMANDS = [
  'gesture',
  'addPage',
  'extendNote',
  'createDocument',
  'renameDocument',
  'changePage',
  'setPageSource',
  'setObject',
  'deleteObject',
  'deleteShapes',
  'transformShapes',
  'pasteShapes',
  'reprocess',
  'undo',
  'redo',
  'clear',
] as const;
export type EditCommand = (typeof EDIT_COMMANDS)[number];
export interface EditArguments {
  gesture: [gesture: Gesture, sessionId: number];
  addPage: [
    documentId: number,
    afterPageId: number,
    width: number | null,
    height: number | null,
    layout?: BlankPageLayout,
  ];
  createDocument: [name: string, layout?: BlankPageLayout];
  extendNote: [pageId: number];
  renameDocument: [id: number, name: string];
  changePage: [pageId: number, action: 'earlier' | 'later' | 'delete'];
  setPageSource: [pageId: number, source: PageSource];
  setObject: [input: ObjectInput];
  deleteObject: [pageId: number, id: number];
  deleteShapes: [pageId: number, ids: number[]];
  transformShapes: [pageId: number, ids: number[], change: SelectionTransform];
  pasteShapes: [pageId: number, items: ClipboardInk[]];
  reprocess: [pageId: number, ids: number[], policy: InkPolicy];
  undo: [pageId: number];
  redo: [pageId: number];
  clear: [pageId: number];
}
export interface FrontendSnapshot {
  state: Readonly<State>;
  documentId: number;
  pageId: number;
  sessionId: number;
  ready: boolean;
  busy: boolean;
}
export interface FrontendHost {
  snapshot(): FrontendSnapshot;
  subscribe(listener: (snapshot: FrontendSnapshot) => void): () => void;
  execute<K extends EditCommand>(command: K, args: EditArguments[K]): Promise<void>;
  navigate(pageId: number): void;
  insertText(): Promise<void>;
}
