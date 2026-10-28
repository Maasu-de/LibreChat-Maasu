import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { GovernanceFinding } from 'librechat-data-provider';
import DlpInterventionDialog, {
  sentText,
  groupFileFindings,
  buildRedactedSegments,
} from '../DlpInterventionDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    [key, ...Object.values(values ?? {})].join(' '),
}));

const PROJECTS = 'CUSTOM_8F14E45FCEEA167A5A36DEDD4BEA2543';
const CLIENTS = 'CUSTOM_C9F0F895FB98AB9159F51FD0297E236D';
const MASK_HIGHLIGHT = 'bg-aimo-mask/35';
const WARN_HIGHLIGHT = 'bg-aimo-warn/25';
const BLOCK_HIGHLIGHT = 'bg-aimo-block/20';
const REDACTED = ['bg-text-primary', 'text-surface-primary'];
const EMAIL_WARN = 'com_ui_dlp_category_email_address · com_ui_dlp_decision_warn';
const PROJECT_MASK = 'com_ui_dlp_category_project_name · com_ui_dlp_decision_mask';
/** The bar of a value the gateway does not replace shows its category. */
const PROJECT_TOKEN = '[com_ui_dlp_category_project_name]';
const EMAIL_TOKEN = '[com_ui_dlp_category_email_address]';

/** The redaction bar that holds a replacement or the value revealed in its place. */
const barOf = (element: HTMLElement) => {
  const bar = element.closest('mark');
  if (!bar) {
    throw new Error('not in a redaction bar');
  }
  return bar;
};
/** Whether a bar shows its replacement, not the original value laid over it. */
const showsToken = (bar: HTMLElement) => bar.querySelector('.invisible') === null;

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
  it('redacts each finding in the text and keeps the text around it', () => {
    const project = finding({ action: 'WARN', replacement: undefined });
    const segments = buildRedactedSegments('Discuss Project Acme now', [
      project,
      finding({ start: 30, end: 34 }),
      finding({ location: '/messages/1/content' }),
    ]);

    expect(segments).toEqual([
      { text: 'Discuss ' },
      { text: 'Project Acme', finding: project },
      { text: ' now' },
    ]);
    expect(sentText(segments)).toBe('Discuss Project Acme now');
  });

  it('uses Unicode code-point offsets supplied by the governance backend', () => {
    const segments = buildRedactedSegments('🙂 Email me@example.com', [
      finding({ start: 8, end: 22, category: 'EMAIL_ADDRESS' }),
    ]);

    expect(segments[1].text).toBe('me@example.com');
  });

  it('redacts each value the gateway replaces like the gateway masks it', () => {
    const [later, earlier] = crossingFindings;
    const segments = buildRedactedSegments(CROSSING, crossingFindings);

    expect(segments).toEqual([
      { text: 'Status of ' },
      { text: 'Project Phoenix', finding: earlier },
      { text: ' ' },
      { text: 'Secret', finding: later },
      { text: ' today' },
    ]);
    expect(sentText(segments)).toBe('Status of [TERM] [TERM] today');
  });

  it('redacts the rest of a finding that a replaced value partly covers', () => {
    const [term, email] = overlapFindings;
    const segments = buildRedactedSegments(OVERLAP, overlapFindings);

    expect(segments).toEqual([
      { text: 'alfa romeo', finding: term },
      { text: '@example.com', finding: email },
    ]);
    expect(sentText(segments)).toBe('[overlap test]@example.com');
  });

  it('keeps the text that findings without a replacement share in the earlier bar', () => {
    const [later, earlier] = crossingFindings.map((f) => ({ ...f, replacement: undefined }));
    const segments = buildRedactedSegments(CROSSING, [later, earlier]);

    expect(segments).toEqual([
      { text: 'Status of ' },
      { text: 'Project Phoenix', finding: earlier },
      { text: ' Secret', finding: later },
      { text: ' today' },
    ]);
    expect(sentText(segments)).toBe(CROSSING);
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
  it('shows only the masked prompt as it will be sent, each replacement set as a bar', () => {
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

    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_masked_prompt' });
    const bar = barOf(within(prompt).getByText('[CONFIDENTIAL]'));
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_original_prompt' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_file_findings' })).toBeNull();
    expect(prompt.textContent).toBe(`Discuss [CONFIDENTIAL] (${PROJECT_MASK}) now`);
    expect(bar).toHaveClass(...REDACTED);
    expect(screen.queryByText('Project Acme')).toBeNull();
    expect(screen.getByRole('button', { name: 'com_ui_cancel' })).toHaveFocus();

    fireEvent.click(screen.getByText('com_ui_dlp_send_masked'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('com_ui_cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the masked text from the gateway as is when it differs from the local rule', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [finding()],
          maskedPreview: [{ location: '/messages/0/content', text: 'Discuss <redacted> now' }],
        }}
        originalText="Discuss Project Acme now"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_masked_prompt' });
    expect(prompt.textContent).toBe('Discuss <redacted> now');
    expect(within(prompt).queryByText('Project Acme')).toBeNull();
  });

  it('redacts a blocked prompt the same way, without a continuation action', () => {
    const iban = 'DE89370400440532013000';
    render(
      <DlpInterventionDialog
        result={{
          decision: 'BLOCK',
          findings: [
            finding({ action: 'BLOCK', replacement: undefined }),
            finding({ start: 26, end: 48, category: 'IBAN_CODE', replacement: '[IBAN]' }),
          ],
        }}
        originalText={`Discuss Project Acme, pay ${iban}`}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_original_prompt' });
    const bar = barOf(within(prompt).getByText(PROJECT_TOKEN));
    expect(prompt.textContent).toBe(
      `Discuss ${PROJECT_TOKEN} (com_ui_dlp_category_project_name · com_ui_dlp_decision_block)` +
        ', pay [IBAN] (com_ui_dlp_category_iban_code · com_ui_dlp_decision_mask)',
    );
    expect(bar).toHaveClass(...REDACTED);
    expect(barOf(within(prompt).getByText('[IBAN]'))).toHaveClass(...REDACTED);
    expect(screen.queryByText('Project Acme')).toBeNull();
    expect(screen.queryByText(iban)).toBeNull();

    fireEvent.mouseEnter(bar);
    expect(barOf(screen.getByText('Project Acme'))).toBe(bar);
    expect(bar).toHaveClass(BLOCK_HIGHLIGHT);

    expect(screen.queryByText('com_ui_dlp_continue')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_send_masked')).not.toBeInTheDocument();
  });

  it('shows a card per attached file above the prompt', () => {
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
    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_masked_prompt' });
    expect(files.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prompt.textContent).toBe('Summarize');
    expect(
      screen.getByText('com_ui_dlp_category_iban_code · com_ui_dlp_decision_mask × 2'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('com_ui_dlp_category_phone_number · com_ui_dlp_decision_warn'),
    ).toBeInTheDocument();
    expect(screen.getByText('com_ui_dlp_send_masked')).toBeInTheDocument();
  });

  it('shows the values found in a file only in the popup of their badge', () => {
    const emails = Array.from({ length: 53 }, (_, i) => `user${i}@example.com`);
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
              count: 60,
              terms: emails,
            },
          ],
        }}
        originalText="Who is on this list?"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const badge = screen.getByRole('button', { name: EMAIL_WARN });
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('user0@example.com')).not.toBeInTheDocument();

    fireEvent.mouseEnter(badge);
    const popup = screen.getByRole('dialog', { name: EMAIL_WARN });
    expect(badge).toHaveAttribute('aria-expanded', 'true');
    expect(within(popup).getByText('user0@example.com')).toBeInTheDocument();
    expect(within(popup).getByText('user49@example.com')).toBeInTheDocument();
    expect(within(popup).queryByText('user50@example.com')).not.toBeInTheDocument();
    expect(within(popup).getByText('com_ui_dlp_more_terms 3')).toBeInTheDocument();
  });

  describe('popup of a file finding badge', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const renderFileFinding = (onCancel = jest.fn()) =>
      render(
        <DlpInterventionDialog
          result={{
            decision: 'WARN',
            findings: [],
            fileFindings: [
              {
                filename: 'notes.txt',
                category: 'EMAIL_ADDRESS',
                action: 'WARN',
                count: 1,
                terms: ['max@example.com'],
              },
            ],
          }}
          originalText="Summarize"
          onCancel={onCancel}
          onConfirm={jest.fn()}
        />,
      );
    const popup = () => screen.queryByRole('dialog', { name: EMAIL_WARN });
    const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms));

    it('leaves the initial focus on cancel', () => {
      renderFileFinding();
      expect(screen.getByRole('button', { name: 'com_ui_cancel' })).toHaveFocus();
    });

    it('opens on hover without taking focus, and closes when the pointer leaves', () => {
      renderFileFinding();
      const badge = screen.getByRole('button', { name: EMAIL_WARN });

      fireEvent.mouseEnter(badge);
      expect(popup()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_cancel' })).toHaveFocus();

      fireEvent.mouseLeave(badge);
      fireEvent.mouseEnter(popup() as HTMLElement);
      wait(500);
      expect(popup()).toBeInTheDocument();

      fireEvent.mouseLeave(popup() as HTMLElement);
      wait(500);
      expect(popup()).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_cancel' })).toHaveFocus();
    });

    it('stays open once clicked, until a click outside', () => {
      renderFileFinding();
      const badge = screen.getByRole('button', { name: EMAIL_WARN });

      fireEvent.mouseEnter(badge);
      fireEvent.click(badge);
      fireEvent.mouseLeave(badge);
      wait(500);
      expect(popup()).toBeInTheDocument();

      fireEvent.pointerDown(screen.getByText('Summarize'));
      expect(popup()).not.toBeInTheDocument();
    });

    it('opens from the keyboard and closes on Escape without closing the dialog', () => {
      const onCancel = jest.fn();
      renderFileFinding(onCancel);
      const badge = screen.getByRole('button', { name: EMAIL_WARN });

      badge.focus();
      fireEvent.click(badge);
      expect(popup()).toBeInTheDocument();
      expect(badge).toHaveFocus();

      fireEvent.keyDown(badge, { key: 'Escape' });
      expect(popup()).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'com_ui_dlp_warn_title' })).toBeInTheDocument();
      expect(onCancel).not.toHaveBeenCalled();
      expect(badge).toHaveFocus();
    });
  });

  it('falls back to a readable label for a built-in category without its own copy', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'WARN',
          findings: [finding({ category: 'VAT_ID', action: 'WARN', replacement: undefined })],
        }}
        originalText="Discuss Project Acme now"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const bar = barOf(screen.getByText('[VAT ID]'));
    expect(within(bar).getByText('(VAT ID · com_ui_dlp_decision_warn)')).toHaveClass('sr-only');
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

    expect(screen.getByRole('region', { name: 'com_ui_dlp_masked_prompt' }).textContent).toBe(
      '[Project Names] (Project Names · com_ui_dlp_decision_mask) for ' +
        '[Client Names] (Client Names · com_ui_dlp_decision_mask), mail ' +
        '[EMAIL] (com_ui_dlp_category_email_address · com_ui_dlp_decision_mask)',
    );
    expect(screen.getByText('Project Names · com_ui_dlp_decision_mask × 2')).toBeInTheDocument();
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

    const bar = barOf(screen.getByText('[com_ui_dlp_category_custom_term]'));
    expect(
      within(bar).getByText('(com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn)'),
    ).toHaveClass('sr-only');
    expect(
      screen.getByText('com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn'),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('CUSTOM_');
  });

  it('redacts a warned prompt the same way, the text findings share in one bar', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'WARN',
          findings: crossingFindings.map((f) =>
            finding({ ...f, action: 'WARN', replacement: undefined }),
          ),
          maskedPreview: [{ location: '/messages/0/content', text: CROSSING }],
        }}
        originalText={CROSSING}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const label = '(com_ui_dlp_category_project_name · com_ui_dlp_decision_warn)';
    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_original_prompt' });
    const [first, second] = within(prompt).getAllByText(PROJECT_TOKEN).map(barOf);

    expect(prompt.textContent).toBe(
      `Status of ${PROJECT_TOKEN} ${label}${PROJECT_TOKEN} ${label} today`,
    );
    expect(first).toHaveClass(...REDACTED);
    expect(second).toHaveClass(...REDACTED);

    fireEvent.mouseEnter(first);
    expect(barOf(screen.getByText('Project Phoenix'))).toBe(first);
    expect(first).toHaveClass(WARN_HIGHLIGHT);
    expect(showsToken(second)).toBe(true);

    fireEvent.mouseEnter(second);
    expect(barOf(screen.getByText('Secret'))).toBe(second);
    expect(showsToken(first)).toBe(true);
  });

  it('sets overlapping masked values like the gateway replaces them', () => {
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
    const [first, second] = screen.getAllByText('[TERM]').map(barOf);

    fireEvent.mouseEnter(second);
    expect(barOf(screen.getByText('Secret'))).toBe(second);
    expect(second).toHaveClass(MASK_HIGHLIGHT);
    expect(showsToken(first)).toBe(true);
    expect(first).toHaveClass(...REDACTED);

    fireEvent.mouseEnter(first);
    expect(barOf(screen.getByText('Project Phoenix'))).toBe(first);
    expect(showsToken(second)).toBe(true);
  });

  describe('redaction bar', () => {
    const renderMasked = () =>
      render(
        <DlpInterventionDialog
          result={{
            decision: 'MASK',
            findings: [finding()],
            maskedPreview: [
              { location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' },
            ],
          }}
          originalText="Discuss Project Acme now"
          onCancel={jest.fn()}
          onConfirm={jest.fn()}
        />,
      );
    const tokenBar = () => barOf(screen.getByText('[CONFIDENTIAL]'));
    const revealedIn = (bar: HTMLElement) =>
      !showsToken(bar) && within(bar).queryByText('Project Acme') !== null;
    const moveTo = (clientX: number, clientY: number) =>
      fireEvent.mouseMove(document, { clientX, clientY });
    /** Client rects given as [left, top, right, bottom]. */
    const rects = (...boxes: [number, number, number, number][]) => {
      const list = boxes.map(([left, top, right, bottom]) => ({
        left,
        top,
        right,
        bottom,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        toJSON: () => ({}),
      }));
      return Object.assign(list, { item: (i: number) => list[i] ?? null });
    };

    it('shows the original value in place of the bar while the pointer is on it', () => {
      renderMasked();
      const bar = tokenBar();

      fireEvent.mouseEnter(bar);
      expect(revealedIn(bar)).toBe(true);
      expect(within(bar).getByText('[CONFIDENTIAL]')).toHaveClass('invisible');
      expect(bar).toHaveClass(MASK_HIGHLIGHT);
      expect(bar).not.toHaveClass(...REDACTED);
      expect(screen.queryByRole('dialog', { name: PROJECT_MASK })).toBeNull();
      expect(screen.getByRole('button', { name: 'com_ui_cancel' })).toHaveFocus();

      moveTo(500, 500);
      expect(showsToken(bar)).toBe(true);
      expect(within(bar).queryByText('Project Acme')).toBeNull();
      expect(bar).toHaveClass(...REDACTED);
    });

    it('keeps the value until the pointer leaves both the place of the bar and the value', () => {
      renderMasked();
      const bar = tokenBar();
      const place = jest.spyOn(bar, 'getClientRects').mockReturnValue(rects([100, 10, 160, 30]));

      fireEvent.mouseEnter(bar);
      place.mockReturnValue(rects([0, 42, 180, 62]));

      moveTo(150, 20);
      expect(revealedIn(bar)).toBe(true);
      moveTo(20, 50);
      expect(revealedIn(bar)).toBe(true);
      moveTo(300, 50);
      expect(showsToken(bar)).toBe(true);
    });

    it('shows the original value while the bar has focus', () => {
      renderMasked();
      const bar = tokenBar();

      act(() => bar.focus());
      expect(revealedIn(bar)).toBe(true);

      act(() => screen.getByRole('button', { name: 'com_ui_cancel' }).focus());
      expect(showsToken(bar)).toBe(true);
    });
  });

  it('lights only the hovered bar, also beside the bar of a value the gateway replaces', () => {
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
    const bar = barOf(screen.getByText('[overlap test]'));
    const rest = barOf(screen.getByText(EMAIL_TOKEN));
    expect(within(rest).getByText(`(${EMAIL_WARN})`)).toHaveClass('sr-only');

    fireEvent.mouseEnter(rest);
    expect(barOf(screen.getByText('@example.com'))).toBe(rest);
    expect(rest).toHaveClass(WARN_HIGHLIGHT);
    expect(showsToken(bar)).toBe(true);
    expect(bar).toHaveClass(...REDACTED);

    fireEvent.mouseEnter(bar);
    expect(barOf(screen.getByText('alfa romeo'))).toBe(bar);
    expect(bar).toHaveClass(MASK_HIGHLIGHT);
    expect(showsToken(rest)).toBe(true);
    expect(rest).toHaveClass(...REDACTED);
  });

  it('lights no file badge while a bar with its value is hovered, and no bar while it is', () => {
    const iban = 'DE89370400440532013000';
    const ibanMask = 'com_ui_dlp_category_iban_code · com_ui_dlp_decision_mask';
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [finding({ start: 4, end: 26, category: 'IBAN_CODE', replacement: '[IBAN]' })],
          fileFindings: [
            {
              filename: 'invoice.md',
              category: 'IBAN_CODE',
              action: 'MASK',
              count: 1,
              terms: [iban],
            },
          ],
          maskedPreview: [{ location: '/messages/0/content', text: 'Pay [IBAN] now' }],
        }}
        originalText={`Pay ${iban} now`}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const badge = screen.getByRole('button', { name: ibanMask });
    const bar = barOf(screen.getByText('[IBAN]'));

    fireEvent.mouseEnter(badge);
    expect(screen.getByRole('dialog', { name: ibanMask })).toHaveTextContent(iban);
    expect(bar).toHaveClass(...REDACTED);
    expect(showsToken(bar)).toBe(true);
    fireEvent.mouseLeave(badge);

    fireEvent.mouseEnter(bar);
    expect(bar).toHaveClass(MASK_HIGHLIGHT);
    expect(badge).not.toHaveClass(MASK_HIGHLIGHT);
  });

  it('only shows the values of a file badge, lighting neither them nor the prompt', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'WARN',
          findings: [
            finding({
              start: 5,
              end: 20,
              category: 'EMAIL_ADDRESS',
              action: 'WARN',
              replacement: undefined,
            }),
          ],
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
    const lit = () => document.getElementsByClassName(WARN_HIGHLIGHT);
    const badge = screen.getByRole('button', { name: EMAIL_WARN });
    const bar = barOf(screen.getByText(EMAIL_TOKEN));

    fireEvent.mouseEnter(bar);
    expect(bar).toHaveClass(WARN_HIGHLIGHT);
    expect(badge).not.toHaveClass(WARN_HIGHLIGHT);
    act(() => screen.getByRole('button', { name: 'com_ui_cancel' }).focus());
    fireEvent.mouseMove(document, { clientX: 500, clientY: 500 });

    fireEvent.mouseEnter(badge);
    const inFile = within(screen.getByRole('dialog', { name: EMAIL_WARN })).getByText(
      'MAX@example.com',
    );
    expect(lit()).toHaveLength(0);

    fireEvent.mouseEnter(inFile);
    expect(lit()).toHaveLength(0);
    expect(showsToken(bar)).toBe(true);
  });
});
