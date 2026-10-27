import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GovernanceFinding } from 'librechat-data-provider';
import DlpInterventionDialog, {
  keyFindings,
  groupFileFindings,
  buildMaskedSegments,
  buildFindingSegments,
} from '../DlpInterventionDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    [key, ...Object.values(values ?? {})].join(' '),
}));

const PROJECTS = 'CUSTOM_8F14E45FCEEA167A5A36DEDD4BEA2543';
const CLIENTS = 'CUSTOM_C9F0F895FB98AB9159F51FD0297E236D';
const MASK_HIGHLIGHT = 'bg-aimo-mask/35';
const WARN_HIGHLIGHT = 'bg-aimo-warn/25';

const finding = (overrides: Partial<GovernanceFinding> = {}): GovernanceFinding => ({
  location: '/messages/0/content',
  start: 8,
  end: 20,
  category: 'PROJECT_NAME',
  action: 'MASK',
  replacement: '[CONFIDENTIAL]',
  ...overrides,
});

const CROSSING = 'Status of Project Phoenix Secret today';
const crossingFindings = [
  finding({ start: 18, end: 32, replacement: '[TERM]' }),
  finding({ start: 10, end: 25, replacement: '[TERM]' }),
];

/** A confidential term and an email address that share "romeo", as in the #191 wireframe. */
const OVERLAP = 'alfa romeo@example.com';
const overlapFindings = [
  finding({ start: 0, end: 10, category: 'OVERLAP_TEST', replacement: '[overlap test]' }),
  finding({
    start: 5,
    end: 22,
    category: 'EMAIL_ADDRESS',
    action: 'WARN',
    replacement: undefined,
  }),
];

describe('DLP intervention text segmentation', () => {
  it('keeps sensitive original text separate from surrounding text', () => {
    const segments = buildFindingSegments('Discuss Project Acme now', [finding()]);

    expect(segments.map((segment) => segment.text)).toEqual(['Discuss ', 'Project Acme', ' now']);
    expect(segments[1].findings?.[0].finding.category).toBe('PROJECT_NAME');
  });

  it('underlines overlapping findings in full on separate rows', () => {
    const segments = buildFindingSegments(CROSSING, crossingFindings);

    expect(
      segments.map(({ text, findings }) => [text, findings?.map(({ lane, ends }) => [lane, ends])]),
    ).toEqual([
      ['Status of ', undefined],
      ['Project ', [[0, false]]],
      [
        'Phoenix',
        [
          [0, true],
          [1, false],
        ],
      ],
      [' Secret', [[1, true]]],
      [' today', undefined],
    ]);
  });

  it('uses Unicode code-point offsets supplied by the governance backend', () => {
    const segments = buildFindingSegments('🙂 Email me@example.com', [
      finding({ start: 8, end: 22, category: 'EMAIL_ADDRESS' }),
    ]);

    expect(segments[1].text).toBe('me@example.com');
  });

  it('keys each value by its category, ignoring case and spacing', () => {
    const [first, second, outside] = keyFindings('Acme Corp and ACME  corp', [
      finding({ start: 0, end: 9 }),
      finding({ start: 14, end: 24 }),
      finding({ start: 40, end: 44 }),
    ]);

    expect(first.key).toBeDefined();
    expect(first.key).toBe(second.key);
    expect(outside.key).toBeUndefined();
  });

  it('places each replacement like the gateway, with the findings it stands for', () => {
    const [later, earlier] = crossingFindings;
    const segments = buildMaskedSegments(CROSSING, crossingFindings);

    expect(segments.map(({ text }) => text).join('')).toBe('Status of [TERM] [TERM] today');
    expect(segments).toEqual([
      { text: 'Status of ', findings: [] },
      { text: '[TERM]', findings: [earlier, later], replaced: earlier },
      { text: ' ', findings: [later] },
      { text: '[TERM]', findings: [later], replaced: later },
      { text: ' today', findings: [] },
    ]);
  });

  it('links the unmasked rest of a finding to it in the masked prompt', () => {
    const [term, email] = overlapFindings;

    expect(buildMaskedSegments(OVERLAP, overlapFindings)).toEqual([
      { text: '[overlap test]', findings: [term, email], replaced: term },
      { text: '@example.com', findings: [email] },
    ]);
  });

  it('groups the findings of each file by category and action, with distinct values', () => {
    const files = groupFileFindings([
      {
        filename: 'report.pdf',
        fileId: 'file-1',
        type: 'application/pdf',
        category: 'IBAN_CODE',
        action: 'MASK',
        count: 3,
        terms: ['DE89370400440532013000', 'de89370400440532013000'],
      },
      { filename: 'notes.txt', category: 'EMAIL_ADDRESS', action: 'WARN', count: 1 },
      {
        filename: 'report.pdf',
        fileId: 'file-1',
        category: 'EMAIL_ADDRESS',
        action: 'WARN',
        count: 1,
        terms: ['max@example.com'],
      },
    ]);

    expect(files).toEqual([
      {
        id: '["file-1","report.pdf"]',
        filename: 'report.pdf',
        type: 'application/pdf',
        groups: [
          { category: 'IBAN_CODE', action: 'MASK', count: 3, terms: ['DE89370400440532013000'] },
          { category: 'EMAIL_ADDRESS', action: 'WARN', count: 1, terms: ['max@example.com'] },
        ],
      },
      {
        id: '[null,"notes.txt"]',
        filename: 'notes.txt',
        groups: [{ category: 'EMAIL_ADDRESS', action: 'WARN', count: 1, terms: undefined }],
      },
    ]);
  });
});

describe('DlpInterventionDialog', () => {
  it('shows the complete MASK preview and provides cancel and send actions', () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();

    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [finding()],
          maskedPreview: [{ location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' }],
        }}
        originalText="Discuss Project Acme now"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText('Project Acme', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_file_findings' })).toBeNull();
    expect(screen.getByRole('region', { name: 'com_ui_dlp_masked_prompt' }).textContent).toBe(
      'Discuss [CONFIDENTIAL] now',
    );
    expect(screen.getByText('com_ui_dlp_send_masked')).toBeInTheDocument();

    fireEvent.click(screen.getByText('com_ui_dlp_send_masked'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('com_ui_cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not provide a continuation action for BLOCK', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'BLOCK',
          findings: [finding({ action: 'BLOCK', replacement: undefined })],
        }}
        originalText="Discuss Project Acme now"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByText('Project Acme', { selector: 'mark' })).toHaveAttribute(
      'title',
      'com_ui_dlp_category_project_name · com_ui_dlp_decision_block',
    );
    expect(screen.queryByText('com_ui_dlp_continue')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_send_masked')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_masked_prompt' })).toBeNull();
  });

  it('shows a card per attached file without a masked prompt when the text has no findings', () => {
    const sheet = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [],
          fileFindings: [
            { filename: 'report.pdf', category: 'IBAN_CODE', action: 'MASK', count: 2 },
            { filename: 'report.pdf', category: 'PHONE_NUMBER', action: 'WARN', count: 1 },
            {
              filename: 'team.xlsx',
              type: sheet,
              category: 'EMAIL_ADDRESS',
              action: 'MASK',
              count: 1,
            },
          ],
          maskedPreview: [{ location: '/messages/0/content', text: 'Summarize' }],
        }}
        originalText="Summarize"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole('region', { name: 'com_ui_dlp_file_findings' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'report.pdf',
      'team.xlsx',
    ]);
    expect(screen.getByText('Document')).toBeInTheDocument();
    expect(screen.getByText('Spreadsheet')).toBeInTheDocument();
    const files = screen.getByRole('region', { name: 'com_ui_dlp_file_findings' });
    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_original_prompt' });
    expect(files.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByText('com_ui_dlp_category_iban_code · com_ui_dlp_decision_mask × 2'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('com_ui_dlp_category_phone_number · com_ui_dlp_decision_warn'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_masked_prompt' })).toBeNull();
    expect(screen.getByText('com_ui_dlp_send_masked')).toBeInTheDocument();
  });

  it('lists the values found in a file and counts those it leaves out', () => {
    const emails = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `${name}@example.com`);
    render(
      <DlpInterventionDialog
        result={{
          decision: 'WARN',
          findings: [],
          fileFindings: [
            {
              filename: 'team.csv',
              category: 'EMAIL_ADDRESS',
              action: 'WARN',
              count: 9,
              terms: emails,
            },
          ],
        }}
        originalText="Who is on this list?"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(
      screen.getByText('com_ui_dlp_category_email_address · com_ui_dlp_decision_warn'),
    ).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('e@example.com')).toBeInTheDocument();
    expect(screen.queryByText('f@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_dlp_more_terms 2')).toBeInTheDocument();
  });

  it('falls back to a readable label for a built-in category without its own copy', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'WARN',
          findings: [finding({ category: 'VAT_ID', action: 'WARN' })],
        }}
        originalText="Discuss Project Acme now"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByText('Project Acme', { selector: 'mark' })).toHaveAttribute(
      'title',
      'VAT ID · com_ui_dlp_decision_warn → [CONFIDENTIAL]',
    );
    expect(screen.getByText('(VAT ID · com_ui_dlp_decision_warn)')).toHaveClass('sr-only');
  });

  it('shows custom categories by their display names, never by their keys', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [
            finding({
              start: 0,
              end: 7,
              category: PROJECTS,
              label: 'Project Names',
              replacement: '[Project Names]',
            }),
            finding({
              start: 12,
              end: 19,
              category: CLIENTS,
              label: 'Client Names',
              replacement: '[Client Names]',
            }),
            finding({ start: 26, end: 42, category: 'EMAIL_ADDRESS', replacement: '[EMAIL]' }),
          ],
          fileFindings: [
            {
              filename: 'notes.txt',
              category: PROJECTS,
              label: 'Project Names',
              action: 'MASK',
              count: 2,
            },
          ],
          maskedPreview: [
            {
              location: '/messages/0/content',
              text: '[Project Names] for [Client Names], mail [EMAIL]',
            },
          ],
        }}
        originalText="Phoenix for Contoso, mail jane@example.com"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByText('Phoenix', { selector: 'mark' })).toHaveAttribute(
      'title',
      'Project Names · com_ui_dlp_decision_mask → [Project Names]',
    );
    expect(screen.getByText('Contoso', { selector: 'mark' })).toHaveAttribute(
      'title',
      'Client Names · com_ui_dlp_decision_mask → [Client Names]',
    );
    expect(screen.getByText('Project Names · com_ui_dlp_decision_mask × 2')).toBeInTheDocument();
    expect(screen.getByText('[Project Names]')).toBeInTheDocument();
    expect(screen.getByText('[Client Names]')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('CUSTOM_');
  });

  it('shows a generic label for a custom category without display name', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'WARN',
          findings: [finding({ category: PROJECTS, action: 'WARN', replacement: undefined })],
          fileFindings: [{ filename: 'notes.txt', category: CLIENTS, action: 'WARN', count: 1 }],
        }}
        originalText="Discuss Project Acme now"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(
      screen.getByText('(com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn)'),
    ).toHaveClass('sr-only');
    expect(
      screen.getByText('com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn'),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('CUSTOM_');
  });

  it('labels text that overlapping findings share with each of them', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: crossingFindings,
          maskedPreview: [
            { location: '/messages/0/content', text: 'Status of [TERM] [TERM] today' },
          ],
        }}
        originalText={CROSSING}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const label = 'com_ui_dlp_category_project_name · com_ui_dlp_decision_mask';

    expect(screen.getByText('Phoenix', { selector: 'mark' })).toHaveAttribute(
      'title',
      `${label} → [TERM]\n${label} → [TERM]`,
    );
    expect(screen.getAllByText(`(${label})`)).toHaveLength(2);
  });

  it('highlights a value in the original and the masked prompt while it is hovered', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [finding()],
          maskedPreview: [{ location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' }],
        }}
        originalText="Discuss Project Acme now"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const original = screen.getByText('Project Acme', { selector: 'mark' });
    const replacement = screen.getByText('[CONFIDENTIAL]');

    fireEvent.mouseEnter(original);
    expect(original).toHaveClass(MASK_HIGHLIGHT);
    expect(replacement).toHaveClass(MASK_HIGHLIGHT);

    fireEvent.mouseLeave(original);
    expect(original).not.toHaveClass(MASK_HIGHLIGHT);
    expect(replacement).not.toHaveClass(MASK_HIGHLIGHT);

    fireEvent.mouseEnter(replacement);
    expect(original).toHaveClass(MASK_HIGHLIGHT);
    expect(replacement).toHaveClass(MASK_HIGHLIGHT);
  });

  it('highlights everything a part of the masked prompt stands for while it is hovered', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: overlapFindings,
          maskedPreview: [{ location: '/messages/0/content', text: '[overlap test]@example.com' }],
        }}
        originalText={OVERLAP}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const mark = (text: string) => screen.getByText(text, { selector: 'mark' });

    fireEvent.mouseEnter(screen.getByText('@example.com', { selector: 'span' }));

    expect(mark('alfa')).not.toHaveClass(MASK_HIGHLIGHT);
    expect(mark('romeo')).toHaveClass(WARN_HIGHLIGHT);
    expect(mark('@example.com')).toHaveClass(WARN_HIGHLIGHT);
    expect(screen.getByText('[overlap test]')).toHaveClass(WARN_HIGHLIGHT);
  });

  it('highlights a value in the prompt while the same value is hovered in a file', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'WARN',
          findings: [finding({ start: 5, end: 20, category: 'EMAIL_ADDRESS', action: 'WARN' })],
          fileFindings: [
            {
              filename: 'notes.txt',
              category: 'EMAIL_ADDRESS',
              action: 'WARN',
              count: 1,
              terms: ['MAX@example.com'],
            },
          ],
        }}
        originalText="Mail max@example.com"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const inFile = screen.getByText('MAX@example.com', { selector: 'li span' });
    const inPrompt = screen.getByText('max@example.com', { selector: 'mark' });

    fireEvent.mouseEnter(inFile);
    expect(inPrompt).toHaveClass(WARN_HIGHLIGHT);
    expect(inFile).toHaveClass(WARN_HIGHLIGHT);

    fireEvent.mouseLeave(inFile);
    fireEvent.mouseEnter(inPrompt);
    expect(inFile).toHaveClass(WARN_HIGHLIGHT);
  });
});
