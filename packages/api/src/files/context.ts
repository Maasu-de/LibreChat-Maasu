import { logger } from '@librechat/data-schemas';
import { FileSources, mergeFileConfig } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { processTextWithTokenLimit } from '~/utils/text';
import type { TokenCountFn } from '~/utils/text';

const FILE_CONTEXT_START = 'Attached document(s):\n```md';
const FILE_SEPARATOR = '\n\n---\n\n';
const FILE_CONTEXT_END = '\n```';
const FILE_HEADER_START = '# "';
const FILE_HEADER_END = '"\n';

/** One attached file's span within a message, in code points like the gateway's DLP findings. */
export interface FileContextSegment {
  filename: string;
  start: number;
  end: number;
}

/**
 * Finds the files in the attached-document block that `extractFileContext` adds to a message.
 * The last file runs to the last closing fence, so pass only the content before the message's
 * own text when it is known: a fence in that text would otherwise extend the last file.
 */
export function findFileContextSegments(content: string): FileContextSegment[] {
  const blockStart = content.indexOf(FILE_CONTEXT_START);
  if (blockStart === -1) {
    return [];
  }

  const closing = content.lastIndexOf(`\n${FILE_CONTEXT_END}`);
  const blockEnd = closing > blockStart ? closing + 1 : content.length;
  const codePoints = (index: number) => Array.from(content.slice(0, index)).length;
  const segments: FileContextSegment[] = [];
  let cursor = blockStart + FILE_CONTEXT_START.length;
  while (content.startsWith(FILE_HEADER_START, cursor)) {
    const nameEnd = content.indexOf(FILE_HEADER_END, cursor + FILE_HEADER_START.length);
    if (nameEnd === -1 || nameEnd >= blockEnd) {
      break;
    }
    const next = content.indexOf(`${FILE_SEPARATOR}${FILE_HEADER_START}`, nameEnd);
    const end = next === -1 || next >= blockEnd ? blockEnd : next;
    segments.push({
      filename: content.slice(cursor + FILE_HEADER_START.length, nameEnd),
      start: codePoints(cursor),
      end: codePoints(end),
    });
    if (end === blockEnd) {
      break;
    }
    cursor = end + FILE_SEPARATOR.length;
  }
  return segments;
}

/** The attachments whose text `extractFileContext` adds to a message, in the order it adds them. */
export function getFileContextFiles(attachments: IMongoFile[]): IMongoFile[] {
  return attachments.filter(
    (file) => (file.source ?? FileSources.local) === FileSources.text && Boolean(file.text),
  );
}

/**
 * Extracts text context from attachments and returns formatted text.
 * This handles text that was already extracted from files (OCR, transcriptions, document text, etc.)
 * @param params - The parameters object
 * @param params.attachments - Array of file attachments
 * @param params.req - Express request object for config access
 * @param params.tokenCountFn - Function to count tokens in text
 * @returns The formatted file context text, or undefined if no text found
 */
export async function extractFileContext({
  attachments,
  req,
  tokenCountFn,
}: {
  attachments: IMongoFile[];
  req?: ServerRequest;
  tokenCountFn: TokenCountFn;
}): Promise<string | undefined> {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const fileConfig = mergeFileConfig(req?.config?.fileConfig);
  const fileTokenLimit = req?.body?.fileTokenLimit ?? fileConfig.fileTokenLimit;

  if (!fileTokenLimit) {
    // If no token limit, return undefined (no processing)
    return undefined;
  }

  let resultText = '';

  for (const file of getFileContextFiles(attachments)) {
    const { text: limitedText, wasTruncated } = await processTextWithTokenLimit({
      text: file.text ?? '',
      tokenLimit: fileTokenLimit,
      tokenCountFn,
    });

    if (wasTruncated) {
      logger.debug(
        `[extractFileContext] Text content truncated for file: ${file.filename} due to token limits`,
      );
    }

    resultText += `${!resultText ? FILE_CONTEXT_START : FILE_SEPARATOR}${FILE_HEADER_START}${file.filename}${FILE_HEADER_END}${limitedText}\n`;
  }

  if (resultText) {
    resultText += FILE_CONTEXT_END;
    return resultText;
  }

  return undefined;
}
