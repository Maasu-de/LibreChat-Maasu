import { v4 } from 'uuid';
import type { Root, Text, Data } from 'mdast';
import type { Node } from 'unist';
import type { MaskedSegment } from './MaskedText';

interface MarkdownNode extends Node {
  data?: Data;
  children?: MarkdownNode[];
  value?: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  identifier?: string;
  label?: string | null;
  lang?: string | null;
  meta?: string | null;
}

const STRING_FIELDS = [
  'value',
  'url',
  'title',
  'alt',
  'identifier',
  'label',
  'lang',
  'meta',
] as const;

/** Protects replacements from Markdown syntax, then decorates only prose in the parsed tree. */
export function prepareMaskedMarkdown(segments: MaskedSegment[]) {
  const text = segments.map((segment) => segment.text).join('');
  const normalized = text.toLowerCase();
  let prefix = `librechatdlpmask${v4().replaceAll('-', '')}`;
  while (normalized.includes(prefix)) {
    prefix += 'x';
  }
  const masks = segments.flatMap(({ mask }) => (mask ? [mask] : []));
  let nextMask = 0;
  const content = segments
    .map(({ text: value, mask }) => (mask ? `${prefix}${nextMask++}end` : value))
    .join('');
  const pattern = new RegExp(`${prefix}([0-9]+)end`, 'g');
  const restore = (value: string) =>
    value.replace(
      pattern,
      (placeholder, index: string) => masks[Number(index)]?.replacement ?? placeholder,
    );

  const restoreChildren = (children: MarkdownNode[]): void => {
    for (const child of children) {
      if (typeof child.value === 'string') {
        child.value = restore(child.value);
      }
      if (child.children) {
        restoreChildren(child.children);
      }
    }
  };

  const decorate = (node: MarkdownNode): void => {
    if (node.data?.hChildren) {
      restoreChildren(node.data.hChildren);
    }
    if (node.type !== 'text') {
      for (const field of STRING_FIELDS) {
        const value = node[field];
        if (typeof value === 'string') {
          node[field] = restore(value);
        }
      }
    }
    if (!node.children) {
      return;
    }
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text' || child.value == null) {
        decorate(child);
        return [child];
      }
      const parts: Text[] = [];
      let cursor = 0;
      for (const match of child.value.matchAll(pattern)) {
        const maskIndex = Number(match[1]);
        const mask = masks[maskIndex];
        if (!mask) {
          continue;
        }
        if (match.index > cursor) {
          parts.push({ type: 'text', value: child.value.slice(cursor, match.index) });
        }
        parts.push({
          type: 'text',
          value: mask.replacement,
          data: {
            hName: 'mark',
            hProperties: { 'data-dlp-mask': maskIndex },
            hChildren: [{ type: 'text', value: mask.replacement }],
          },
        });
        cursor = match.index + match[0].length;
      }
      if (cursor === 0) {
        return [child];
      }
      if (cursor < child.value.length) {
        parts.push({ type: 'text', value: child.value.slice(cursor) });
      }
      return parts;
    });
  };

  return { content, masks, remarkPlugin: () => (tree: Root) => decorate(tree) };
}
