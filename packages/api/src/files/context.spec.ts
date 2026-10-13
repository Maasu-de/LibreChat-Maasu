import { FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import { extractFileContext, getFileContextFiles, findFileContextSegments } from './context';

const textFile = (filename: string, text: string, file_id = filename) =>
  ({ file_id, filename, text, source: FileSources.text }) as IMongoFile;

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

describe('getFileContextFiles', () => {
  it('lists the files of the attached-document block in its order, one per segment', async () => {
    const attachments = [
      textFile('report.pdf', 'first', 'file-1'),
      { file_id: 'image-1', filename: 'photo.png', source: FileSources.local } as IMongoFile,
      textFile('empty.txt', '', 'file-2'),
      textFile('report.pdf', 'second', 'file-3'),
    ];
    const fileContext = await extractFileContext({
      attachments,
      tokenCountFn: (text) => text.length,
    });

    const files = getFileContextFiles(attachments);

    expect(files.map(({ file_id }) => file_id)).toEqual(['file-1', 'file-3']);
    expect(findFileContextSegments(fileContext ?? '')).toHaveLength(files.length);
  });
});
