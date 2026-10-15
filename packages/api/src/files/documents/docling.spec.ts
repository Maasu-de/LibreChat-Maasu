import os from 'os';
import path from 'path';
import http from 'http';
import * as fs from 'fs';
import { logger } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import { doclingPdfToMarkdown, getDoclingURL } from './docling';
import { parseDocument } from './crud';

interface CapturedRequest {
  url?: string;
  method?: string;
  contentType?: string;
  body: string;
}

describe('Docling PDF extraction', () => {
  let server: http.Server;
  let baseURL: string;
  let pdfPath: string;
  let tmpDir: string;
  let captured: CapturedRequest | undefined;
  let respond: (res: http.ServerResponse) => void;

  const pdfFile = (): Express.Multer.File =>
    ({
      originalname: 'report.pdf',
      path: pdfPath,
      mimetype: 'application/pdf',
      size: fs.statSync(pdfPath).size,
    }) as Express.Multer.File;

  const json = (status: number, body: object) => (res: http.ServerResponse) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docling-spec-'));
    pdfPath = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4 fake pdf bytes');

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        captured = {
          url: req.url,
          method: req.method,
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    captured = undefined;
    respond = json(200, { status: 'success', document: { md_content: '# Report\n\n| a | b |' } });
  });

  afterEach(() => {
    delete process.env.DOCLING_URL;
    jest.restoreAllMocks();
  });

  test('getDoclingURL() is undefined unless DOCLING_URL is set, and strips trailing slashes', () => {
    expect(getDoclingURL()).toBeUndefined();
    process.env.DOCLING_URL = '  ';
    expect(getDoclingURL()).toBeUndefined();
    process.env.DOCLING_URL = 'http://docling:5001//';
    expect(getDoclingURL()).toBe('http://docling:5001');
  });

  test('doclingPdfToMarkdown() posts the PDF to the sync endpoint and returns Markdown', async () => {
    const text = await doclingPdfToMarkdown(pdfFile(), baseURL);

    expect(text).toBe('# Report\n\n| a | b |');
    expect(captured?.method).toBe('POST');
    expect(captured?.url).toBe('/v1/convert/file');
    expect(captured?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(captured?.body).toContain('filename="report.pdf"');
    expect(captured?.body).toContain('%PDF-1.4 fake pdf bytes');
    expect(captured?.body).toMatch(/name="to_formats"\r\n\r\nmd\r\n/);
    expect(captured?.body).toMatch(/name="image_export_mode"\r\n\r\nplaceholder\r\n/);
    expect(captured?.body).toMatch(/name="do_ocr"\r\n\r\nfalse\r\n/);
  });

  test('doclingPdfToMarkdown() accepts partial_success and logs the errors', async () => {
    respond = json(200, {
      status: 'partial_success',
      document: { md_content: 'page 1' },
      errors: [{ error_message: 'page 2 timed out' }],
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await expect(doclingPdfToMarkdown(pdfFile(), baseURL)).resolves.toBe('page 1');

    expect(warn).toHaveBeenCalledWith(
      '[Docling] Partial conversion of "report.pdf": page 2 timed out',
    );
  });

  test('doclingPdfToMarkdown() throws when Docling returns no content', async () => {
    respond = json(200, { status: 'success', document: { md_content: '  \n' } });
    await expect(doclingPdfToMarkdown(pdfFile(), baseURL)).rejects.toThrow(
      'Docling conversion success returned no content',
    );

    respond = json(200, { status: 'success' });
    await expect(doclingPdfToMarkdown(pdfFile(), baseURL)).rejects.toThrow(
      'Docling conversion success returned no content',
    );
  });

  test('doclingPdfToMarkdown() throws with Docling errors on a failed conversion', async () => {
    respond = json(200, {
      status: 'failure',
      document: { md_content: null },
      errors: [{ error_message: 'corrupt xref table' }],
    });
    await expect(doclingPdfToMarkdown(pdfFile(), baseURL)).rejects.toThrow(
      'Docling conversion failure: corrupt xref table',
    );
  });

  test('parseDocument() uses Docling for PDFs when DOCLING_URL is set', async () => {
    process.env.DOCLING_URL = baseURL;

    const document = await parseDocument({ file: pdfFile() });

    expect(captured?.url).toBe('/v1/convert/file');
    expect(document).toEqual({
      filename: 'report.pdf',
      bytes: Buffer.byteLength('# Report\n\n| a | b |', 'utf8'),
      filepath: 'document_parser',
      text: '# Report\n\n| a | b |',
      images: [],
    });
  });

  test('parseDocument() falls back to pdfjs when Docling returns no content', async () => {
    process.env.DOCLING_URL = baseURL;
    respond = json(200, { status: 'success', document: { md_content: '' } });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await expect(parseDocument({ file: pdfFile() })).rejects.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Docling failed for "report\.pdf", falling back to pdfjs: .*no content/,
      ),
    );
  });

  test('parseDocument() falls back to pdfjs when Docling fails', async () => {
    process.env.DOCLING_URL = baseURL;
    respond = json(500, { detail: 'boom' });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    await expect(parseDocument({ file: pdfFile() })).rejects.toThrow();

    expect(captured?.url).toBe('/v1/convert/file');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Docling failed for "report\.pdf", falling back to pdfjs: .*500/),
    );
  });
});
