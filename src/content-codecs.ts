import { PluginRegistry } from './plugins.ts';

/** Source editing is independent of rendering and editor presentation. */
export interface ContentCodec {
  decode(data: unknown): string;
  encode(source: string): unknown;
}
export const contentCodecs = new PluginRegistry<ContentCodec>();
const sourceCodec: ContentCodec = {
  decode: (data) =>
    typeof data === 'object' && data !== null && 'source' in data && typeof data.source === 'string'
      ? data.source
      : '',
  encode: (source) => ({ source }),
};
for (const format of ['text/markdown', 'text/plain', 'math/latex', 'image/svg+xml'])
  contentCodecs.set(format, sourceCodec);
const jsonCodec: ContentCodec = {
  decode: (data) => JSON.stringify(data, null, 2),
  encode: (source) => JSON.parse(source),
};
export function contentCodec(format: string): ContentCodec {
  return contentCodecs.get(format) ?? jsonCodec;
}
