import React from 'react';
import { render, screen } from '@testing-library/react';
import type { GovernanceMaskedSpan } from 'librechat-data-provider';
import { getMaskedSegments } from '../MaskedText';
import MarkdownLite from '../MarkdownLite';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

jest.mock('~/Providers', () => ({
  ArtifactProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CodeBlockProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../MarkdownErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../MarkdownComponents', () => ({
  a: 'a',
  p: 'p',
  img: 'img',
  table: 'table',
  code: 'code',
  codeNoExecution: 'code',
}));

const masksFor = (text: string, replacements: string[]): GovernanceMaskedSpan[] => {
  let cursor = 0;
  return replacements.map((replacement) => {
    const index = text.indexOf(replacement, cursor);
    cursor = index + replacement.length;
    return {
      start: Array.from(text.slice(0, index)).length,
      end: Array.from(text.slice(0, cursor)).length,
      category: 'IBAN_CODE',
      replacement,
    };
  });
};

const renderMasked = (text: string, replacements: string[]) =>
  render(
    <MarkdownLite
      content={text}
      maskedSegments={getMaskedSegments(text, masksFor(text, replacements))}
    />,
  );

it('preserves headings, lists, emphasis and links around masks, including Unicode offsets', () => {
  const text = '# Invoice 🙂\n\n- Pay **[IBAN]** today\n- Read [instructions](https://example.com)';
  const { container } = renderMasked(text, ['[IBAN]']);

  expect(screen.getByRole('heading', { level: 1, name: 'Invoice 🙂' })).toBeVisible();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByRole('link', { name: 'instructions' })).toHaveAttribute(
    'href',
    'https://example.com',
  );
  expect(container.querySelector('strong mark')).toHaveTextContent('com_ui_dlp_category_iban_code');
  expect(container.querySelector('mark')).toHaveClass('bg-text-primary');
});

it('only decorates recorded masks and treats replacement Markdown syntax literally', () => {
  const replacement = '[**Secret**]';
  const text = `Pay ${replacement}, then [IBAN].\n\n[IBAN]: https://example.com`;
  const { container } = renderMasked(text, [replacement]);

  expect(container.querySelectorAll('mark')).toHaveLength(1);
  expect(container.querySelector('mark')).toHaveTextContent('com_ui_dlp_category_iban_code');
  expect(container.querySelector('mark strong')).toBeNull();
  expect(screen.getByRole('link', { name: 'IBAN' })).toHaveAttribute('href', 'https://example.com');
});

it('keeps inline and fenced code intact with ordinary replacement text', () => {
  const { container } = renderMasked('Use `[IBAN]`\n\n```text\nPay [IBAN]\nnow\n```', [
    '[IBAN]',
    '[IBAN]',
  ]);

  expect(container.querySelector('p > code')).toHaveTextContent('[IBAN]');
  expect(container.querySelector('pre > code')).toHaveTextContent('Pay [IBAN] now');
  expect(container.querySelector('mark')).toBeNull();
  expect(container).not.toHaveTextContent('librechatdlpmask');
});

it('restores masks in URLs, titles, image alt text and reference definitions', () => {
  const text =
    '[link](https://example.com/[IBAN] "[TITLE]")\n\n![Image [ALT]](https://example.com/image.png)\n\n[ref]\n\n[ref]: https://example.com/[REF]';
  const { container } = renderMasked(text, ['[IBAN]', '[TITLE]', '[ALT]', '[REF]']);

  expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute(
    'href',
    'https://example.com/%5BIBAN%5D',
  );
  expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute('title', '[TITLE]');
  expect(screen.getByRole('img')).toHaveAttribute('alt', 'Image [ALT]');
  expect(screen.getByRole('link', { name: 'ref' })).toHaveAttribute(
    'href',
    'https://example.com/%5BREF%5D',
  );
  expect(container.innerHTML).not.toContain('librechatdlpmask');
});

it('keeps math rendering free of placeholders', () => {
  const { container } = renderMasked('Value $$\\text{[IBAN]}$$\n\n$$\n\\text{[IBAN]}\n$$', [
    '[IBAN]',
    '[IBAN]',
  ]);

  expect(container.querySelectorAll('.katex')).toHaveLength(2);
  expect(container.querySelectorAll('annotation')[0]).toHaveTextContent('\\text{[IBAN]}');
  expect(container.querySelectorAll('annotation')[1]).toHaveTextContent('\\text{[IBAN]}');
  expect(container.innerHTML).not.toContain('librechatdlpmask');
});

it('does not confuse existing placeholder-looking text with a mask', () => {
  const { container } = renderMasked('LIBRECHATDLPMASK0END Pay [IBAN]', ['[IBAN]']);

  expect(container).toHaveTextContent('LIBRECHATDLPMASK0END');
  expect(container.querySelectorAll('mark')).toHaveLength(1);
  expect(container.querySelector('mark')).toHaveTextContent('com_ui_dlp_category_iban_code');
});

it('does not mistake entity-decoded user text for a recorded mask', () => {
  const { container } = renderMasked('librechatdlpm&#97;sk0end Pay [IBAN]', ['[IBAN]']);

  expect(container).toHaveTextContent('librechatdlpmask0end Pay com_ui_dlp_category_iban_code');
  expect(container.querySelectorAll('mark')).toHaveLength(1);
});

it('renders normal Markdown when masks no longer match', () => {
  const text = '# Edited invoice';
  const { container } = render(
    <MarkdownLite
      content={text}
      maskedSegments={getMaskedSegments(text, masksFor('[IBAN]', ['[IBAN]']))}
    />,
  );

  expect(screen.getByRole('heading', { name: 'Edited invoice' })).toBeVisible();
  expect(container.querySelector('mark')).toBeNull();
});
