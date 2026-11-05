import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  GovernanceTier,
  GovernanceDlpResult,
  GovernanceFinding,
  GovernanceMaskedRange,
} from 'librechat-data-provider';
import DlpInterventionDialog, {
  groupFileFindings,
  buildPromptSegments,
} from '../DlpInterventionDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    [key, ...Object.values(values ?? {})].join(' '),
}));

const PROJECTS = 'CUSTOM_8F14E45FCEEA167A5A36DEDD4BEA2543';
const CLIENTS = 'CUSTOM_C9F0F895FB98AB9159F51FD0297E236D';
const MASK_HIGHLIGHT = 'bg-aimo-mask/35';
const WARN_HIGHLIGHT = 'bg-aimo-warn/40';
const BLOCK_HIGHLIGHT = 'bg-aimo-block/30';
const REDACTED = ['bg-text-primary', 'text-surface-primary'];
const EMAIL_WARN = 'com_ui_dlp_category_email_address · com_ui_dlp_decision_warn';
const PROJECT_LABEL = 'com_ui_dlp_category_project_name';
const PROJECT_MASK = `${PROJECT_LABEL} · com_ui_dlp_decision_mask`;

/** The redaction bar that holds a category label or the value revealed in its place. */
const barOf = (element: HTMLElement) => {
  const bar = element.closest('mark');
  if (!bar) {
    throw new Error('not in a redaction bar');
  }
  return bar;
};
/** Whether a bar shows its category label, not the original value laid over it. */
const showsLabel = (bar: HTMLElement) => bar.querySelector('.invisible') === null;

const finding = (overrides: Partial<GovernanceFinding> = {}): GovernanceFinding => ({
  location: '/messages/0/content',
  start: 8,
  end: 20,
  category: 'PROJECT_NAME',
  action: 'MASK',
  replacement: '[CONFIDENTIAL]',
  ...overrides,
});
/** The range the gateway replaces for the first finding, `finding()` itself by default. */
const maskedAt = (start = 8, end = 20): GovernanceMaskedRange[] => [{ start, end, finding: 0 }];

const CROSSING = 'Status of Project Phoenix Secret today';
const crossingFindings = [
  finding({ start: 18, end: 32, replacement: '[TERM]' }),
  finding({ start: 10, end: 25, replacement: '[TERM]' }),
];
/** The later finding is masked from after the earlier one, without the space between them. */
const crossingRanges: GovernanceMaskedRange[] = [
  { start: 10, end: 25, finding: 1 },
  { start: 26, end: 32, finding: 0 },
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
  it('splits the text at each finding in it', () => {
    const warned = { action: 'WARN' as const, replacement: undefined };
    const project = finding(warned);
    const segments = buildPromptSegments('Discuss Project Acme now', [
      project,
      finding({ ...warned, start: 30, end: 34 }),
      finding({ ...warned, location: '/messages/1/content' }),
    ]);

    expect(segments).toEqual([
      { text: 'Discuss ' },
      { text: 'Project Acme', finding: project },
      { text: ' now' },
    ]);
  });

  it('uses Unicode code-point offsets supplied by the governance backend', () => {
    const segments = buildPromptSegments(
      '🙂 Email me@example.com',
      [finding({ start: 8, end: 22, category: 'EMAIL_ADDRESS' })],
      maskedAt(8, 22),
    );

    expect(segments[1].text).toBe('me@example.com');
  });

  it('gives each value the gateway replaces the range the review gives it', () => {
    const [later, earlier] = crossingFindings;

    expect(buildPromptSegments(CROSSING, crossingFindings, crossingRanges)).toEqual([
      { text: 'Status of ' },
      { text: 'Project Phoenix', finding: earlier },
      { text: ' ' },
      { text: 'Secret', finding: later },
      { text: ' today' },
    ]);
  });

  it('keeps the rest of a finding that a replaced value partly covers', () => {
    const [term, email] = overlapFindings;

    expect(buildPromptSegments(OVERLAP, overlapFindings, maskedAt(0, 10))).toEqual([
      { text: 'alfa romeo', finding: term },
      { text: '@example.com', finding: email },
    ]);
  });

  it('gives the text that kept findings share to the more severe, else the earlier one', () => {
    const [later, earlier] = crossingFindings.map((f) => ({ ...f, replacement: undefined }));
    const blocked = { ...later, action: 'BLOCK' as const };

    expect(buildPromptSegments(CROSSING, [later, earlier])).toEqual([
      { text: 'Status of ' },
      { text: 'Project Phoenix', finding: earlier },
      { text: ' Secret', finding: later },
      { text: ' today' },
    ]);
    expect(buildPromptSegments(CROSSING, [blocked, earlier])).toEqual([
      { text: 'Status of ' },
      { text: 'Project ', finding: earlier },
      { text: 'Phoenix Secret', finding: blocked },
      { text: ' today' },
    ]);
  });

  it('groups the findings of each file by category and action, with their values', () => {
    const files = groupFileFindings([
      {
        filename: 'report.pdf',
        fileId: 'file-1',
        type: 'application/pdf',
        category: 'IBAN_CODE',
        action: 'MASK',
        count: 3,
        terms: ['DE89370400440532013000'],
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
  it('shows the masked prompt with a friendly category label on each bar', () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();

    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [finding()],
          maskedRanges: maskedAt(),
          maskedPreview: [{ location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' }],
        }}
        originalText="Discuss Project Acme now"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_masked_prompt' });
    const bar = barOf(within(prompt).getByText(PROJECT_LABEL));
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_original_prompt' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_file_findings' })).toBeNull();
    expect(prompt.textContent).toBe(`Discuss ${PROJECT_LABEL} (${PROJECT_MASK}) now`);
    expect(bar).toHaveClass(...REDACTED);
    expect(screen.queryByText('Project Acme')).toBeNull();
    expect(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' })).toHaveFocus();

    fireEvent.click(screen.getByText('com_ui_dlp_send_masked'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('com_ui_cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('distinguishes categories sharing the same replacement', () => {
    const preview = {
      location: '/messages/0/content',
      text: 'Mail [CONFIDENTIAL] about [CONFIDENTIAL]',
    };
    const result: GovernanceDlpResult = {
      decision: 'MASK',
      findings: [
        finding({ start: 5, end: 21, category: 'EMAIL_ADDRESS' }),
        finding({ start: 28, end: 40 }),
      ],
      maskedRanges: [
        { start: 5, end: 21, finding: 0 },
        { start: 28, end: 40, finding: 1 },
      ],
      maskedPreview: [preview],
    };
    render(
      <DlpInterventionDialog
        result={result}
        originalText="Mail jane@example.com about Project Acme"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_masked_prompt' });
    for (const label of ['com_ui_dlp_category_email_address', PROJECT_LABEL]) {
      const visibleLabel = within(prompt).getByText(label);
      expect(visibleLabel).toBeVisible();
      expect(visibleLabel.closest('.sr-only')).toBeNull();
      expect(barOf(visibleLabel)).toHaveClass(...REDACTED);
    }
    expect(within(prompt).queryByText('[CONFIDENTIAL]')).not.toBeInTheDocument();
  });

  it.each([
    ['VAT_ID', 'VAT ID'],
    [PROJECTS, 'com_ui_dlp_category_custom_term'],
  ])('shows a friendly mask label for %s without a display name', (category, label) => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [finding({ category })],
          maskedRanges: maskedAt(),
        }}
        originalText="Discuss Project Acme now"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const visibleLabel = screen.getByText(label);
    expect(visibleLabel).toBeVisible();
    expect(visibleLabel.closest('.sr-only')).toBeNull();
    expect(screen.queryByText('[CONFIDENTIAL]')).not.toBeInTheDocument();
  });

  it('shows blocked values on their color and masked ones as bars, with no way to send', () => {
    const iban = 'DE89370400440532013000';
    render(
      <DlpInterventionDialog
        result={{
          decision: 'BLOCK',
          findings: [
            finding({ action: 'BLOCK', replacement: undefined }),
            finding({ start: 26, end: 48, category: 'IBAN_CODE', replacement: '[IBAN]' }),
          ],
          maskedRanges: [{ start: 26, end: 48, finding: 1 }],
        }}
        originalText={`Discuss Project Acme, pay ${iban}`}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    const prompt = screen.getByRole('region', { name: 'com_ui_dlp_original_prompt' });
    const blocked = within(prompt).getByText('Project Acme', { selector: 'mark' });
    expect(prompt.textContent).toBe(
      'Discuss Project Acme (com_ui_dlp_category_project_name · com_ui_dlp_decision_block)' +
        ', pay com_ui_dlp_category_iban_code (com_ui_dlp_category_iban_code · com_ui_dlp_decision_mask)',
    );
    expect(blocked).toHaveClass(BLOCK_HIGHLIGHT);
    expect(blocked).not.toHaveClass(...REDACTED);
    expect(barOf(within(prompt).getByText('com_ui_dlp_category_iban_code'))).toHaveClass(
      ...REDACTED,
    );
    expect(screen.queryByText(iban)).toBeNull();

    expect(screen.queryByText('com_ui_dlp_continue')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_send_masked')).not.toBeInTheDocument();
  });

  describe('a model the content does not allow', () => {
    const renderModelBlock = (findings: GovernanceFinding[], allowedTiers: GovernanceTier[]) =>
      render(
        <DlpInterventionDialog
          result={{
            decision: 'BLOCK',
            findings,
            modelNotAllowed: { model: 'public-s2', allowedTiers },
          }}
          originalText="Discuss Project Acme now"
          onCancel={jest.fn()}
          onConfirm={jest.fn()}
        />,
      );

    it('names the model and the allowed tiers, with every value shown unmasked', () => {
      const tier = { code: 'S1', name: 'EU Sovereign', description: 'Hosted in the EU.' };
      renderModelBlock([finding({ replacement: undefined })], [tier]);

      expect(screen.getByRole('dialog', { name: 'com_ui_dlp_model_blocked_title' })).toBeVisible();
      expect(screen.getByText('com_ui_dlp_model_blocked_description public-s2')).toBeVisible();
      const tiers = screen.getByRole('region', { name: 'com_ui_dlp_allowed_tiers' });
      expect(tiers).toHaveTextContent('EU Sovereign · Hosted in the EU.');
      const prompt = screen.getByRole('region', { name: 'com_ui_dlp_original_prompt' });
      const value = within(prompt).getByText('Project Acme', { selector: 'mark' });
      expect(value).toHaveClass(MASK_HIGHLIGHT);
      expect(value).not.toHaveClass(...REDACTED);
      expect(screen.getByRole('button', { name: 'com_ui_close' })).toBeVisible();
      expect(screen.queryByText('com_ui_dlp_send_masked')).not.toBeInTheDocument();
    });

    it('says when no model may take it, and leaves out a prompt without findings', () => {
      renderModelBlock([], []);

      expect(screen.getByText('com_ui_dlp_model_blocked_no_tier')).toBeVisible();
      expect(screen.queryByRole('region', { name: 'com_ui_dlp_original_prompt' })).toBeNull();
    });
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

  it('shows ten distinct values and expands all the remaining values without submitting', async () => {
    const user = userEvent.setup();
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    const emails = Array.from({ length: 55 }, (_, i) => `user${i}@example.com`);
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
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const badge = screen.getByRole('button', { name: EMAIL_WARN });
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('user0@example.com')).not.toBeInTheDocument();

    fireEvent.mouseEnter(badge);
    const popup = screen.getByRole('dialog', { name: EMAIL_WARN });
    expect(badge).toHaveAttribute('aria-expanded', 'true');
    expect(within(popup).getByText('user0@example.com')).toBeInTheDocument();
    expect(within(popup).getAllByRole('listitem')).toHaveLength(10);
    expect(within(popup).getByText('user9@example.com')).toBeInTheDocument();
    expect(within(popup).queryByText('user10@example.com')).not.toBeInTheDocument();
    const toggle = within(popup).getByRole('button', { name: 'com_ui_dlp_show_all_terms 45' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', within(popup).getByRole('list').id);

    await user.click(toggle);
    expect(within(popup).getAllByRole('listitem')).toHaveLength(55);
    expect(within(popup).getByText('user54@example.com')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('com_ui_dlp_show_fewer_terms');
    expect(toggle).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(within(popup).getAllByRole('listitem')).toHaveLength(10);
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(within(popup).getAllByRole('listitem')).toHaveLength(55);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: EMAIL_WARN })).not.toBeInTheDocument();
    expect(badge).toHaveFocus();
    expect(onCancel).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    const reopened = screen.getByRole('dialog', { name: EMAIL_WARN });
    const collapsed = within(reopened).getByRole('button', {
      name: 'com_ui_dlp_show_all_terms 45',
    });
    expect(within(reopened).getAllByRole('listitem')).toHaveLength(10);
    await user.tab();
    expect(collapsed).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: EMAIL_WARN })).not.toBeInTheDocument();
    expect(badge).toHaveFocus();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps expansion separate for each file finding badge', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [],
          fileFindings: [
            {
              filename: 'team.csv',
              category: 'EMAIL_ADDRESS',
              action: 'WARN',
              count: 55,
              terms: Array.from({ length: 55 }, (_, i) => `user${i}@example.com`),
            },
            {
              filename: 'projects.txt',
              category: 'PROJECT_NAME',
              action: 'MASK',
              count: 12,
              terms: Array.from({ length: 12 }, (_, i) => `Project ${i}`),
            },
          ],
        }}
        originalText="Summarize"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: EMAIL_WARN }));
    const first = screen.getByRole('dialog', { name: EMAIL_WARN });
    fireEvent.click(within(first).getByRole('button', { name: 'com_ui_dlp_show_all_terms 45' }));

    fireEvent.mouseEnter(screen.getByRole('button', { name: PROJECT_MASK }));
    const second = screen.getByRole('dialog', { name: PROJECT_MASK });
    expect(within(first).getAllByRole('listitem')).toHaveLength(55);
    expect(within(second).getAllByRole('listitem')).toHaveLength(10);
    expect(
      within(second).getByRole('button', { name: 'com_ui_dlp_show_all_terms 2' }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([
    ['WARN', ''],
    ['MASK', '   '],
    ['BLOCK', ''],
  ] as const)('omits the empty prompt box for a file-only %s review', (decision, originalText) => {
    render(
      <DlpInterventionDialog
        result={{
          decision,
          findings: [],
          fileFindings: [
            { filename: 'notes.txt', category: 'EMAIL_ADDRESS', action: decision, count: 1 },
          ],
        }}
        originalText={originalText}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.getByRole('region', { name: 'com_ui_dlp_file_findings' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_masked_prompt' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_original_prompt' })).toBeNull();
    expect(
      screen.getByRole('button', {
        name: {
          WARN: 'com_ui_dlp_continue',
          MASK: 'com_ui_dlp_send_masked',
          BLOCK: 'com_ui_close',
        }[decision],
      }),
    ).toBeVisible();
  });

  describe('keyboard', () => {
    const renderDecision = (decision: 'MASK' | 'BLOCK') => {
      const onCancel = jest.fn();
      const onConfirm = jest.fn();
      render(
        <DlpInterventionDialog
          result={{
            decision,
            findings: [finding({ action: decision })],
            maskedRanges: maskedAt(),
            maskedPreview: [
              { location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' },
            ],
          }}
          originalText="Discuss Project Acme now"
          onCancel={onCancel}
          onConfirm={onConfirm}
        />,
      );
      return { onCancel, onConfirm };
    };
    const dialog = () => screen.getByRole('dialog', { name: /^com_ui_dlp_/ });

    it('sends on Enter from the focused send button, once', async () => {
      const { onCancel, onConfirm } = renderDecision('MASK');
      expect(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' })).toHaveFocus();

      await userEvent.setup().keyboard('{Enter}');
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('sends on Enter from anywhere in the dialog but another button', () => {
      const { onCancel, onConfirm } = renderDecision('MASK');

      fireEvent.keyDown(dialog(), { key: 'Enter' });
      fireEvent.keyDown(barOf(screen.getByText(PROJECT_LABEL)), { key: 'Enter' });
      expect(onConfirm).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(screen.getByRole('button', { name: 'com_ui_cancel' }), { key: 'Enter' });
      expect(onConfirm).toHaveBeenCalledTimes(2);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('never sends on a held Enter', () => {
      const { onConfirm } = renderDecision('MASK');
      const send = screen.getByRole('button', { name: 'com_ui_dlp_send_masked' });

      expect(fireEvent.keyDown(send, { key: 'Enter', repeat: true })).toBe(false);
      expect(fireEvent.keyDown(dialog(), { key: 'Enter', repeat: true })).toBe(false);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('cancels on Escape', () => {
      const { onCancel, onConfirm } = renderDecision('MASK');

      fireEvent.keyDown(dialog(), { key: 'Escape' });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('only closes a blocked prompt, focused on close', () => {
      const { onCancel, onConfirm } = renderDecision('BLOCK');
      expect(screen.getByRole('button', { name: 'com_ui_close' })).toHaveFocus();

      fireEvent.keyDown(dialog(), { key: 'Enter' });
      expect(onConfirm).not.toHaveBeenCalled();

      fireEvent.keyDown(dialog(), { key: 'Escape' });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('popup of a file finding badge', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const renderFileFinding = (onCancel = jest.fn(), terms = ['max@example.com']) =>
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
                count: terms.length,
                terms,
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

    it('leaves the initial focus on the button that sends', () => {
      renderFileFinding();
      expect(screen.getByRole('button', { name: 'com_ui_dlp_continue' })).toHaveFocus();
    });

    it('opens on hover without taking focus, and closes when the pointer leaves', () => {
      renderFileFinding();
      const badge = screen.getByRole('button', { name: EMAIL_WARN });

      fireEvent.mouseEnter(badge);
      expect(popup()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_dlp_continue' })).toHaveFocus();

      fireEvent.mouseLeave(badge);
      fireEvent.mouseEnter(popup() as HTMLElement);
      wait(500);
      expect(popup()).toBeInTheDocument();

      fireEvent.mouseLeave(popup() as HTMLElement);
      wait(500);
      expect(popup()).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'com_ui_dlp_continue' })).toHaveFocus();
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

    it('keeps the popup open when its expansion button gains focus or is clicked', () => {
      const onCancel = jest.fn();
      renderFileFinding(
        onCancel,
        Array.from({ length: 12 }, (_, i) => `user${i}@example.com`),
      );
      const badge = screen.getByRole('button', { name: EMAIL_WARN });
      fireEvent.mouseEnter(badge);
      const toggle = within(popup() as HTMLElement).getByRole('button', {
        name: 'com_ui_dlp_show_all_terms 2',
      });

      fireEvent.mouseLeave(badge);
      act(() => toggle.focus());
      wait(500);
      expect(popup()).toBeInTheDocument();

      fireEvent.click(toggle);
      fireEvent.mouseLeave(popup() as HTMLElement);
      wait(500);
      expect(within(popup() as HTMLElement).getAllByRole('listitem')).toHaveLength(12);
      expect(toggle).toHaveFocus();

      fireEvent.keyDown(toggle, { key: 'Escape' });
      expect(popup()).not.toBeInTheDocument();
      expect(badge).toHaveFocus();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('keeps a portaled popup inside the modal and preserves keyboard focus order', async () => {
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const onCancel = jest.fn();
      renderFileFinding(
        onCancel,
        Array.from({ length: 12 }, (_, i) => `user${i}@example.com`),
      );
      const badge = screen.getByRole('button', { name: EMAIL_WARN });
      badge.focus();
      fireEvent.click(badge);
      const content = popup() as HTMLElement;
      const toggle = within(content).getByRole('button', { name: 'com_ui_dlp_show_all_terms 2' });
      expect(content.closest('[role="document"]')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'com_ui_dlp_warn_title' })).toContainElement(
        content,
      );

      await user.tab();
      expect(toggle).toHaveFocus();
      await user.tab({ shift: true });
      expect(badge).toHaveFocus();
      await user.tab();
      expect(toggle).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: 'com_ui_cancel' })).toHaveFocus();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('closes a hovered popup on Escape before the surrounding review', () => {
      const onCancel = jest.fn();
      renderFileFinding(onCancel);
      const badge = screen.getByRole('button', { name: EMAIL_WARN });
      const confirm = screen.getByRole('button', { name: 'com_ui_dlp_continue' });
      fireEvent.mouseEnter(badge);
      expect(confirm).toHaveFocus();

      fireEvent.keyDown(confirm, { key: 'Escape' });
      expect(popup()).not.toBeInTheDocument();
      expect(badge).toHaveFocus();
      expect(onCancel).not.toHaveBeenCalled();
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

    const value = screen.getByText('Project Acme', { selector: 'mark' });
    expect(within(value).getByText('(VAT ID · com_ui_dlp_decision_warn)')).toHaveClass('sr-only');
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
          maskedRanges: [
            { start: 0, end: 7, finding: 0 },
            { start: 12, end: 19, finding: 1 },
            { start: 26, end: 42, finding: 2 },
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
      'Project Names (Project Names · com_ui_dlp_decision_mask) for ' +
        'Client Names (Client Names · com_ui_dlp_decision_mask), mail ' +
        'com_ui_dlp_category_email_address (com_ui_dlp_category_email_address · com_ui_dlp_decision_mask)',
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

    const value = screen.getByText('Project Acme', { selector: 'mark' });
    expect(
      within(value).getByText('(com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn)'),
    ).toHaveClass('sr-only');
    expect(
      screen.getByText('com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn'),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('CUSTOM_');
  });

  it('shows warned values on their color, labeled with each finding', () => {
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

    expect(prompt.textContent).toBe(`Status of Project Phoenix ${label} Secret ${label} today`);
    for (const value of [
      within(prompt).getByText('Project Phoenix', { selector: 'mark' }),
      within(prompt).getByText('Secret', { selector: 'mark' }),
    ]) {
      expect(value).toHaveClass(WARN_HIGHLIGHT);
      expect(value).not.toHaveClass(...REDACTED);
    }
  });

  it('sets overlapping masked values where the review puts them', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: crossingFindings,
          maskedRanges: crossingRanges,
          maskedPreview: [
            { location: '/messages/0/content', text: 'Status of [TERM] [TERM] today' },
          ],
        }}
        originalText={CROSSING}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const [first, second] = screen.getAllByText(PROJECT_LABEL).map(barOf);

    fireEvent.mouseEnter(second);
    expect(barOf(screen.getByText('Secret'))).toBe(second);
    expect(second).toHaveClass(MASK_HIGHLIGHT);
    expect(showsLabel(first)).toBe(true);
    expect(first).toHaveClass(...REDACTED);

    fireEvent.mouseEnter(first);
    expect(barOf(screen.getByText('Project Phoenix'))).toBe(first);
    expect(showsLabel(second)).toBe(true);
  });

  describe('redaction bar', () => {
    const renderMasked = () =>
      render(
        <DlpInterventionDialog
          result={{
            decision: 'MASK',
            findings: [finding()],
            maskedRanges: maskedAt(),
            maskedPreview: [
              { location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' },
            ],
          }}
          originalText="Discuss Project Acme now"
          onCancel={jest.fn()}
          onConfirm={jest.fn()}
        />,
      );
    const labelBar = () => barOf(screen.getByText(PROJECT_LABEL));
    const revealedIn = (bar: HTMLElement) =>
      !showsLabel(bar) && within(bar).queryByText('Project Acme') !== null;
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
      const bar = labelBar();

      fireEvent.mouseEnter(bar);
      expect(revealedIn(bar)).toBe(true);
      expect(within(bar).getByText(PROJECT_LABEL)).toHaveClass('invisible');
      expect(bar).toHaveClass(MASK_HIGHLIGHT);
      expect(bar).not.toHaveClass(...REDACTED);
      expect(screen.queryByRole('dialog', { name: PROJECT_MASK })).toBeNull();
      expect(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' })).toHaveFocus();

      moveTo(500, 500);
      expect(showsLabel(bar)).toBe(true);
      expect(within(bar).queryByText('Project Acme')).toBeNull();
      expect(bar).toHaveClass(...REDACTED);
    });

    it('keeps the value until the pointer leaves both the place of the bar and the value', () => {
      renderMasked();
      const bar = labelBar();
      const place = jest.spyOn(bar, 'getClientRects').mockReturnValue(rects([100, 10, 160, 30]));

      fireEvent.mouseEnter(bar);
      place.mockReturnValue(rects([0, 42, 180, 62]));

      moveTo(150, 20);
      expect(revealedIn(bar)).toBe(true);
      moveTo(20, 50);
      expect(revealedIn(bar)).toBe(true);
      moveTo(300, 50);
      expect(showsLabel(bar)).toBe(true);
    });

    it('shows the original value while the bar has focus', () => {
      renderMasked();
      const bar = labelBar();

      act(() => bar.focus());
      expect(revealedIn(bar)).toBe(true);

      act(() => screen.getByRole('button', { name: 'com_ui_cancel' }).focus());
      expect(showsLabel(bar)).toBe(true);
    });
  });

  it('shows the rest of a warned finding on its color beside the bar of a masked value', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: overlapFindings,
          maskedRanges: maskedAt(0, 10),
          maskedPreview: [{ location: '/messages/0/content', text: '[overlap test]@example.com' }],
        }}
        originalText={OVERLAP}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const bar = barOf(screen.getByText('OVERLAP TEST'));
    const rest = screen.getByText('@example.com', { selector: 'mark' });
    expect(within(rest).getByText(`(${EMAIL_WARN})`)).toHaveClass('sr-only');
    expect(rest).toHaveClass(WARN_HIGHLIGHT);
    expect(bar).toHaveClass(...REDACTED);

    fireEvent.mouseEnter(bar);
    expect(barOf(screen.getByText('alfa romeo'))).toBe(bar);
    expect(bar).toHaveClass(MASK_HIGHLIGHT);
    expect(rest).toHaveClass(WARN_HIGHLIGHT);
  });

  it('lights no file badge while a bar with its value is hovered, and no bar while it is', () => {
    const iban = 'DE89370400440532013000';
    const ibanMask = 'com_ui_dlp_category_iban_code · com_ui_dlp_decision_mask';
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [finding({ start: 4, end: 26, category: 'IBAN_CODE', replacement: '[IBAN]' })],
          maskedRanges: maskedAt(4, 26),
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
    const bar = barOf(screen.getByText('com_ui_dlp_category_iban_code'));

    fireEvent.mouseEnter(badge);
    expect(screen.getByRole('dialog', { name: ibanMask })).toHaveTextContent(iban);
    expect(bar).toHaveClass(...REDACTED);
    expect(showsLabel(bar)).toBe(true);
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
    const lit = () => Array.from(document.getElementsByClassName(WARN_HIGHLIGHT));
    const badge = screen.getByRole('button', { name: EMAIL_WARN });
    const inPrompt = screen.getByText('max@example.com', { selector: 'mark' });
    expect(lit()).toEqual([inPrompt]);

    fireEvent.mouseEnter(inPrompt);
    expect(lit()).toEqual([inPrompt]);

    fireEvent.mouseEnter(badge);
    const inFile = within(screen.getByRole('dialog', { name: EMAIL_WARN })).getByText(
      'MAX@example.com',
    );
    expect(lit()).toEqual([inPrompt]);

    fireEvent.mouseEnter(inFile);
    expect(lit()).toEqual([inPrompt]);
  });
});
