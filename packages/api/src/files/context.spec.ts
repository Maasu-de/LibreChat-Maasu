import { FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import { extractFileContext, findFileContextSegments } from './context';

const textFile = (filename: string, text: string) =>
  ({ filename, text, source: FileSources.text }) as IMongoFile;

const sliceCodePoints = (text: string, start: number, end: number) =>
  Array.from(text).slice(start, end).join('');

describe('findFileContextSegments', () => {
  it('finds each attached file after quoted excerpts, in code points', async () => {
    const fileContext = await extractFileContext({
      attachments: [
        textFile('🙂 report.pdf', 'IBAN DE89370400440532013000\n\n```js\ncode\n```'),
        textFile('notes.txt', 'mail max@example.com'),
      ],
      tokenCountFn: (text) => text.length,
    });
    const content = `> 🙂 quoted\n\n${fileContext}\n`;

    const segments = findFileContextSegments(content);

    expect(segments.map(({ filename }) => filename)).toEqual(['🙂 report.pdf', 'notes.txt']);
    expect(sliceCodePoints(content, segments[0].start, segments[0].end)).toBe(
      '# "🙂 report.pdf"\nIBAN DE89370400440532013000\n\n```js\ncode\n```\n',
    );
    expect(sliceCodePoints(content, segments[1].start, segments[1].end)).toBe(
      '# "notes.txt"\nmail max@example.com\n',
    );
  });

  it('returns no segments for a message without attached documents', () => {
    expect(findFileContextSegments('# "not a file"\njust text')).toEqual([]);
  });
});
