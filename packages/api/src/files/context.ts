import { logger } from '@librechat/data-schemas';
import { FileSources, mergeFileConfig } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { processTextWithTokenLimit } from '~/utils/text';
import type { TokenCountFn } from '~/utils/text';

const FILE_CONTEXT_START = 'Attached document(s):\n```md';
const FILE_SEPARATOR = '\n\n---\n\n';
const FILE_CONTEXT_END = '\n```';

/** One attached file's span in `FileContext.text`, in code points like the gateway's DLP findings. */
export interface FileContextSpan {
  fileId: string;
  filename: string;
  start: number;
  end: number;
}

/** The attached-document block added to a message, with the span of each file in it. */
export interface FileContext {
  text: string;
  files: FileContextSpan[];
}

const codePointLength = (text: string): number => Array.from(text).length;

/**
 * Builds the attached-document block from text already extracted from attachments (OCR,
 * transcriptions, document text, etc.) and records where each file's text lies in it, so the
 * block never has to be parsed back out of message content.
 * @param params - The parameters object
 * @param params.attachments - Array of file attachments
 * @param params.req - Express request object for config access
 * @param params.tokenCountFn - Function to count tokens in text
 * @returns The block and its file spans, or undefined if no text found
 */
export async function buildFileContext({
  attachments,
  req,
  tokenCountFn,
}: {
  attachments: IMongoFile[];
  req?: ServerRequest;
  tokenCountFn: TokenCountFn;
}): Promise<FileContext | undefined> {
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
  let length = 0;
  const files: FileContextSpan[] = [];

  for (const file of attachments) {
    const source = file.source ?? FileSources.local;
    if (source !== FileSources.text || !file.text) {
      continue;
    }
    const { text: limitedText, wasTruncated } = await processTextWithTokenLimit({
      text: file.text,
      tokenLimit: fileTokenLimit,
      tokenCountFn,
    });

    if (wasTruncated) {
      logger.debug(
        `[extractFileContext] Text content truncated for file: ${file.filename} due to token limits`,
      );
    }

    const prefix = !resultText ? FILE_CONTEXT_START : FILE_SEPARATOR;
    const entry = `# "${file.filename}"\n${limitedText}\n`;
    const start = length + codePointLength(prefix);
    length = start + codePointLength(entry);
    resultText += prefix + entry;
    files.push({ fileId: file.file_id, filename: file.filename, start, end: length });
  }

  if (resultText) {
    return { text: resultText + FILE_CONTEXT_END, files };
  }

  return undefined;
}

/**
 * Extracts text context from attachments and returns formatted text.
 * @returns The formatted file context text, or undefined if no text found
 */
export async function extractFileContext(
  params: Parameters<typeof buildFileContext>[0],
): Promise<string | undefined> {
  return (await buildFileContext(params))?.text;
}
