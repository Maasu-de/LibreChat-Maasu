import * as fs from 'fs';
import FormData from 'form-data';
import { logger } from '@librechat/data-schemas';
import type { AxiosRequestConfig } from 'axios';
import { applyAxiosProxyConfig } from '~/utils/proxy';
import { createAxiosInstance } from '~/utils/axios';

/**
 * Docling Serve-backed PDF extraction.
 *
 * Off by default. Operators opt in by setting `DOCLING_URL` to a Docling Serve
 * base URL (e.g. `http://docling:5001`). When set, PDFs are converted to Markdown
 * by Docling, which keeps headings and tables. OCR is off: governance of image-derived
 * text is out of scope, and OCR misreads would let sensitive values slip past DLP, so pages
 * without a text layer yield no text. The document parser falls back to the pdfjs text layer
 * if the call fails.
 */

const axios = createAxiosInstance();

/** Docling runs layout and table models on CPU; large PDFs take minutes. */
const DOCLING_TIMEOUT_MS = 5 * 60 * 1000;

type DoclingConversionStatus =
  | 'pending'
  | 'started'
  | 'success'
  | 'partial_success'
  | 'failure'
  | 'skipped';

interface DoclingConvertResponse {
  document?: { md_content?: string | null };
  status: DoclingConversionStatus;
  errors?: { error_message?: string }[];
}

/** Returns the configured Docling Serve base URL, or `undefined` if Docling is disabled. */
export function getDoclingURL(): string | undefined {
  const url = process.env.DOCLING_URL?.trim();
  return url ? url.replace(/\/+$/, '') : undefined;
}

/**
 * Converts a PDF to Markdown with Docling Serve's synchronous file endpoint.
 * Embedded images are replaced by placeholders so no base64 reaches the prompt.
 *
 * @throws {Error} if the request fails, Docling reports a failed conversion, or returns no content.
 */
export async function doclingPdfToMarkdown(
  file: Express.Multer.File,
  baseURL: string,
): Promise<string> {
  const form = new FormData();
  form.append('files', fs.createReadStream(file.path), {
    filename: 'document.pdf',
    contentType: 'application/pdf',
  });
  form.append('from_formats', 'pdf');
  form.append('to_formats', 'md');
  form.append('image_export_mode', 'placeholder');
  form.append('do_ocr', 'false');
  form.append('do_table_structure', 'true');

  const url = `${baseURL}/v1/convert/file`;
  const config: AxiosRequestConfig = {
    headers: form.getHeaders(),
    timeout: DOCLING_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  };
  applyAxiosProxyConfig(config, url);

  const { data } = await axios.post<DoclingConvertResponse>(url, form, config);
  const reasons = (data.errors ?? []).map((e) => e.error_message).filter(Boolean);
  const detail = reasons.length ? `: ${reasons.join('; ')}` : '';

  if (data.status !== 'success' && data.status !== 'partial_success') {
    throw new Error(`Docling conversion ${data.status}${detail}`);
  }

  const markdown = data.document?.md_content;
  if (!markdown?.trim()) {
    throw new Error(`Docling conversion ${data.status} returned no content${detail}`);
  }

  if (data.status === 'partial_success') {
    logger.warn(`[Docling] Partial conversion${detail}`);
  }

  return markdown;
}
