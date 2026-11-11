import React from 'react';
import { I18nextProvider } from 'react-i18next';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  GovernanceTier,
  GovernanceDlpResult,
  GovernanceFinding,
  GovernanceMaskedRange,
} from 'librechat-data-provider';
import i18n from '~/locales/i18n';
import DlpInterventionDialog, {
  groupFindings,
  buildPromptSegments,
} from '../DlpInterventionDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    [key, ...Object.values(values ?? {})].join(' '),
}));

const PROJECTS = 'CUSTOM_8F14E45FCEEA167A5A36DEDD4BEA2543';
const CLIENTS = 'CUSTOM_C9F0F895FB98AB9159F51FD0297E236D';
const MASK_HIGHLIGHT = 'bg-aimo-mask/35';
const MASK_OVERLAP = 'bg-aimo-mask/65';
const WARN_HIGHLIGHT = 'bg-aimo-warn/20';
const WARN_OVERLAP = 'bg-aimo-warn/40';
const BLOCK_HIGHLIGHT = 'bg-aimo-block/30';
const IBAN = 'DE89370400440532013000';
const EMAIL_LABEL = 'com_ui_dlp_category_email_address';
const EMAIL_WARN = `${EMAIL_LABEL} · com_ui_dlp_decision_warn`;
const EMAIL_MASK = `${EMAIL_LABEL} · com_ui_dlp_decision_mask`;
const PROJECT_LABEL = 'com_ui_dlp_category_project_name';
const PROJECT_MASK = `${PROJECT_LABEL} · com_ui_dlp_decision_mask`;
const PROJECT_WARN = `${PROJECT_LABEL} · com_ui_dlp_decision_warn`;

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

/** Two confidential terms that share "Solja", each in its own custom category. */
const SHARED = 'Bijela Solja Dva';
const sharedFindings = [
  finding({ start: 0, end: 12, category: CLIENTS, label: 'Clients', replacement: '[Clients]' }),
  finding({ start: 7, end: 16, category: PROJECTS, label: 'Projects', replacement: '[Projects]' }),
];
const sharedRanges: GovernanceMaskedRange[] = [
  { start: 0, end: 12, finding: 0 },
  { start: 13, end: 16, finding: 1 },
];

/** A confidential term and an email address that share "romeo". */
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

function renderDialog(result: GovernanceDlpResult, originalText = 'Discuss Project Acme now') {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  render(
    <DlpInterventionDialog
      result={result}
      originalText={originalText}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onCancel, onConfirm };
}

const promptRegion = (name = 'com_ui_dlp_original_prompt') => screen.getByRole('region', { name });
const markOf = (text: string) => screen.getByText(text, { selector: 'mark' });

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
      { text: 'Project Acme', finding: project, overlap: false },
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

  it('gives each value the gateway replaces the range the review gives it, marking what findings share', () => {
    const [later, earlier] = crossingFindings;

    expect(buildPromptSegments(CROSSING, crossingFindings, crossingRanges)).toEqual([
      { text: 'Status of ' },
      { text: 'Project ', finding: earlier, overlap: false },
      { text: 'Phoenix', finding: earlier, overlap: true },
      { text: ' ' },
      { text: 'Secret', finding: later, overlap: false },
      { text: ' today' },
    ]);
  });

  it('marks the words two confidential terms share', () => {
    const [clients, projects] = sharedFindings;

    expect(buildPromptSegments(SHARED, sharedFindings, sharedRanges)).toEqual([
      { text: 'Bijela ', finding: clients, overlap: false },
      { text: 'Solja', finding: clients, overlap: true },
      { text: ' ' },
      { text: 'Dva', finding: projects, overlap: false },
    ]);
  });

  it('keeps the rest of a finding that a replaced value partly covers', () => {
    const [term, email] = overlapFindings;

    expect(buildPromptSegments(OVERLAP, overlapFindings, maskedAt(0, 10))).toEqual([
      { text: 'alfa ', finding: term, overlap: false },
      { text: 'romeo', finding: term, overlap: true },
      { text: '@example.com', finding: email, overlap: false },
    ]);
  });

  it('gives the text that kept findings share to the more severe, else the earlier one', () => {
    const [later, earlier] = crossingFindings.map((f) => ({ ...f, replacement: undefined }));
    const blocked = { ...later, action: 'BLOCK' as const };

    expect(buildPromptSegments(CROSSING, [later, earlier])).toEqual([
      { text: 'Status of ' },
      { text: 'Project ', finding: earlier, overlap: false },
      { text: 'Phoenix', finding: earlier, overlap: true },
      { text: ' Secret', finding: later, overlap: false },
      { text: ' today' },
    ]);
    expect(buildPromptSegments(CROSSING, [blocked, earlier])).toEqual([
      { text: 'Status of ' },
      { text: 'Project ', finding: earlier, overlap: false },
      { text: 'Phoenix', finding: blocked, overlap: true },
      { text: ' Secret', finding: blocked, overlap: false },
      { text: ' today' },
    ]);
  });

  it('groups the findings of each file by category and action, merging their values', () => {
    const files = groupFindings([
      {
        filename: 'report.pdf',
        fileId: 'file-1',
        type: 'application/pdf',
        category: 'IBAN_CODE',
        action: 'MASK',
        replacement: '[IBAN]',
        count: 3,
        terms: [IBAN],
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
      {
        filename: 'report.pdf',
        fileId: 'file-1',
        category: 'EMAIL_ADDRESS',
        action: 'WARN',
        count: 2,
        terms: ['ann@example.com', 'max@example.com'],
      },
    ]);

    expect(files).toEqual([
      {
        id: '["file-1","report.pdf"]',
        filename: 'report.pdf',
        type: 'application/pdf',
        groups: [
          {
            category: 'IBAN_CODE',
            action: 'MASK',
            replacement: '[IBAN]',
            count: 3,
            terms: [IBAN],
          },
          {
            category: 'EMAIL_ADDRESS',
            action: 'WARN',
            count: 3,
            terms: ['max@example.com', 'ann@example.com'],
          },
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
  it('shows the prompt as entered, each value on the color of its action', () => {
    const { onCancel, onConfirm } = renderDialog({
      decision: 'MASK',
      findings: [finding()],
      maskedRanges: maskedAt(),
      maskedPreview: [{ location: '/messages/0/content', text: 'Discuss [CONFIDENTIAL] now' }],
    });

    expect(screen.getByRole('dialog', { name: 'com_ui_dlp_title' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'com_ui_dlp_your_prompt' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'com_ui_dlp_attachments' })).toBeNull();
    expect(promptRegion()).toHaveTextContent(`Discuss Project Acme (${PROJECT_MASK}) now`);
    expect(markOf('Project Acme')).toHaveClass(MASK_HIGHLIGHT);
    expect(within(promptRegion()).getByRole('button', { name: PROJECT_MASK })).toBeVisible();
    expect(screen.getByRole('button', { name: 'com_ui_dlp_send_masked' })).toHaveFocus();

    fireEvent.click(screen.getByText('com_ui_dlp_send_masked'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('com_ui_cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows masked values only where the gateway replaces them, and badges keep the originals', () => {
    const { onConfirm } = renderDialog(
      {
        decision: 'MASK',
        findings: [
          finding({ start: 5, end: 21, category: 'EMAIL_ADDRESS', replacement: '[EMAIL]' }),
          finding({ start: 28, end: 40, action: 'WARN', replacement: undefined }),
        ],
        maskedRanges: [{ start: 5, end: 21, finding: 0 }],
      },
      'Mail jane@example.com about Project Acme',
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_show_masked' }));

    expect(promptRegion('com_ui_dlp_masked_prompt')).toHaveTextContent(
      `Mail [EMAIL] (${EMAIL_MASK}) about Project Acme (${PROJECT_WARN})`,
    );
    expect(markOf('Project Acme')).toHaveClass(WARN_HIGHLIGHT);
    fireEvent.mouseEnter(screen.getByRole('button', { name: EMAIL_MASK }));
    expect(screen.getByRole('dialog', { name: EMAIL_MASK })).toHaveTextContent('jane@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_show_original' }));
    expect(promptRegion()).toHaveTextContent('Mail jane@example.com');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('offers no masked view when the gateway replaces nothing in the prompt', () => {
    renderDialog({
      decision: 'WARN',
      findings: [finding({ action: 'WARN', replacement: undefined })],
      fileFindings: [
        {
          filename: 'report.pdf',
          category: 'IBAN_CODE',
          action: 'MASK',
          replacement: '[IBAN]',
          count: 1,
        },
      ],
    });

    expect(screen.queryByRole('button', { name: 'com_ui_dlp_show_masked' })).toBeNull();
  });

  it('highlights the words two terms share more strongly, and masks each term once', () => {
    renderDialog(
      { decision: 'MASK', findings: sharedFindings, maskedRanges: sharedRanges },
      SHARED,
    );

    expect(markOf('Bijela')).toHaveClass(MASK_HIGHLIGHT);
    expect(markOf('Solja')).toHaveClass(MASK_OVERLAP);
    expect(markOf('Dva')).toHaveClass(MASK_HIGHLIGHT);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_show_masked' }));
    expect(promptRegion('com_ui_dlp_masked_prompt')).toHaveTextContent(
      '[Clients] (Clients · com_ui_dlp_decision_mask) [Projects] (Projects · com_ui_dlp_decision_mask)',
      { normalizeWhitespace: false },
    );
  });

  it('shows warned values on their color, more strongly where they overlap', () => {
    renderDialog(
      {
        decision: 'WARN',
        findings: crossingFindings.map((f) => ({ ...f, action: 'WARN', replacement: undefined })),
      },
      CROSSING,
    );

    expect(promptRegion()).toHaveTextContent(
      `Status of Project (${PROJECT_WARN})Phoenix (${PROJECT_WARN}) Secret (${PROJECT_WARN}) today`,
    );
    expect(markOf('Project')).toHaveClass(WARN_HIGHLIGHT);
    expect(markOf('Phoenix')).toHaveClass(WARN_OVERLAP);
    expect(markOf('Secret')).toHaveClass(WARN_HIGHLIGHT);
  });

  it('keeps the rest of a warned finding beside a masked value', () => {
    renderDialog(
      { decision: 'MASK', findings: overlapFindings, maskedRanges: maskedAt(0, 10) },
      OVERLAP,
    );

    expect(markOf('@example.com')).toHaveClass(WARN_HIGHLIGHT);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_show_masked' }));
    expect(promptRegion('com_ui_dlp_masked_prompt').textContent).toMatch(
      /^\[overlap test\].*@example\.com/,
    );
  });

  it.each([
    [
      ['MASK', 'BLOCK'],
      'BLOCK',
      '(com_ui_dlp_decision_mask + com_ui_dlp_decision_block → com_ui_dlp_decision_block)',
    ],
    [['MASK'], 'MASK', null],
  ] as const)(
    'explains how the actions %j combine into the overall action',
    (actions, decision, combination) => {
      renderDialog(
        {
          decision,
          findings: actions.map((action, index) =>
            finding({ start: index * 9, end: index * 9 + 7, action }),
          ),
        },
        'Discuss Project Acme now',
      );

      const overall = screen.getByRole('region', { name: 'com_ui_dlp_overall_action' });
      expect(overall.textContent).toMatch(
        new RegExp(`^com_ui_dlp_overall_action:com_ui_dlp_decision_${decision.toLowerCase()}`),
      );
      expect(overall).toHaveTextContent(`com_ui_dlp_outcome_${decision.toLowerCase()}`);
      if (combination) {
        expect(overall).toHaveTextContent(combination);
      } else {
        expect(overall.textContent).not.toContain('→');
      }
    },
  );

  it('lets a blocked prompt only be closed or edited', () => {
    const { onCancel, onConfirm } = renderDialog(
      {
        decision: 'BLOCK',
        findings: [
          finding({ action: 'BLOCK', replacement: undefined }),
          finding({ start: 26, end: 48, category: 'IBAN_CODE', replacement: '[IBAN]' }),
        ],
        maskedRanges: [{ start: 26, end: 48, finding: 1 }],
      },
      `Discuss Project Acme, pay ${IBAN}`,
    );

    expect(markOf('Project Acme')).toHaveClass(BLOCK_HIGHLIGHT);
    expect(markOf(IBAN)).toHaveClass(MASK_HIGHLIGHT);
    expect(screen.queryByText('com_ui_dlp_send_masked')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_send_anyway')).not.toBeInTheDocument();
    const edit = screen.getByRole('button', { name: 'com_ui_dlp_edit_prompt' });
    expect(edit).toHaveFocus();

    fireEvent.click(edit);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('names the compared models the findings do not allow, with only a close action', () => {
    const onCancel = jest.fn();

    render(
      <I18nextProvider i18n={i18n}>
        <DlpInterventionDialog
          result={{
            decision: 'BLOCK',
            findings: [finding({ action: 'MASK', replacement: undefined })],
            modelRestriction: {
              models: ['public-s2'],
              categories: ['PROJECT_NAME', 'CUSTOM_TERM'],
            },
          }}
          originalText="Discuss Project Acme now"
          onCancel={onCancel}
          onConfirm={jest.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.getByText('com_ui_dlp_model_restricted_title')).toBeInTheDocument();
    const model = screen.getByText('public-s2');
    expect(model).toHaveClass('rounded-full', 'text-aimo-block-ink');
    expect(model.parentElement).toHaveTextContent(
      "public-s2 can't receive prompts that contain: com_ui_dlp_category_project_name, com_ui_dlp_category_custom_term. Choose a different model or remove it from the comparison to continue with this prompt.",
    );
    expect(markOf('Project Acme')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_edit_prompt')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('com_ui_close'));
    expect(onCancel).toHaveBeenCalled();
  });

  describe('a model the content does not allow', () => {
    const renderModelBlock = (findings: GovernanceFinding[], allowedTiers: GovernanceTier[]) =>
      renderDialog({
        decision: 'BLOCK',
        findings,
        modelNotAllowed: { model: 'public-s2', allowedTiers },
      });

    it('names the model and the allowed tiers, with every value shown as entered', () => {
      const tier = { code: 'S1', name: 'EU Sovereign', description: 'Hosted in the EU.' };
      renderModelBlock([finding({ replacement: undefined })], [tier]);

      expect(screen.getByRole('dialog', { name: 'com_ui_dlp_model_blocked_title' })).toBeVisible();
      expect(screen.getByText('com_ui_dlp_model_blocked_description public-s2')).toBeVisible();
      const tiers = screen.getByRole('region', { name: 'com_ui_dlp_allowed_tiers' });
      expect(tiers).toHaveTextContent('EU Sovereign · Hosted in the EU.');
      expect(within(promptRegion()).getByText('Project Acme', { selector: 'mark' })).toHaveClass(
        MASK_HIGHLIGHT,
      );
      expect(screen.queryByRole('region', { name: 'com_ui_dlp_overall_action' })).toBeNull();
      expect(screen.getByRole('button', { name: 'com_ui_close' })).toBeVisible();
      expect(screen.queryByText('com_ui_dlp_edit_prompt')).not.toBeInTheDocument();
      expect(screen.queryByText('com_ui_dlp_send_masked')).not.toBeInTheDocument();
    });

    it('says when no model may take it, and leaves out a prompt without findings', () => {
      renderModelBlock([], []);

      expect(screen.getByText('com_ui_dlp_model_blocked_no_tier')).toBeVisible();
      expect(screen.queryByRole('region', { name: 'com_ui_dlp_original_prompt' })).toBeNull();
    });
  });

  it('shows each attached file in its own card with its badges, above the prompt', () => {
    const sheet = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    renderDialog(
      {
        decision: 'MASK',
        findings: [finding({ start: 0, end: 9, category: 'EMAIL_ADDRESS', action: 'WARN' })],
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
      },
      'Summarize',
    );

    const attachments = screen.getByRole('region', { name: 'com_ui_dlp_attachments' });
    expect(attachments).toHaveTextContent('com_ui_dlp_files 2 · com_ui_dlp_data_types 3');
    const cards = within(attachments).getAllByRole('listitem');
    expect(cards.map((card) => within(card).getByRole('heading').textContent)).toEqual([
      'report.pdf',
      'team.xlsx',
    ]);
    expect(within(cards[0]).getByText('Document')).toBeInTheDocument();
    expect(
      within(cards[0]).getByText('com_ui_dlp_category_iban_code · com_ui_dlp_decision_mask × 2'),
    ).toBeInTheDocument();
    expect(
      within(cards[0]).getByText('com_ui_dlp_category_phone_number · com_ui_dlp_decision_warn'),
    ).toBeInTheDocument();
    expect(within(cards[1]).getByText('Spreadsheet')).toBeInTheDocument();
    expect(within(cards[1]).getByText(EMAIL_MASK)).toBeInTheDocument();
    expect(
      attachments.compareDocumentPosition(promptRegion()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('counts a single file and data type in the singular', () => {
    renderDialog(
      {
        decision: 'MASK',
        findings: [],
        fileFindings: [{ filename: 'report.pdf', category: 'IBAN_CODE', action: 'MASK', count: 2 }],
      },
      'Summarize',
    );

    expect(screen.getByRole('region', { name: 'com_ui_dlp_attachments' })).toHaveTextContent(
      'com_ui_dlp_one_file 1 · com_ui_dlp_one_data_type 1',
    );
  });

  it('shows ten distinct values and expands all the remaining values without submitting', () => {
    const emails = Array.from({ length: 55 }, (_, i) => `user${i}@example.com`);
    const { onCancel, onConfirm } = renderDialog(
      {
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
      },
      'Who is on this list?',
    );

    const badge = screen.getByRole('button', { name: EMAIL_WARN });
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('user0@example.com')).not.toBeInTheDocument();

    fireEvent.mouseEnter(badge);
    const popup = screen.getByRole('dialog', { name: EMAIL_WARN });
    expect(badge).toHaveAttribute('aria-expanded', 'true');
    expect(within(popup).getAllByRole('listitem')).toHaveLength(10);
    expect(within(popup).getByText('user9@example.com')).toBeInTheDocument();
    expect(within(popup).queryByText('user10@example.com')).not.toBeInTheDocument();
    const toggle = within(popup).getByRole('button', { name: 'com_ui_dlp_show_all_terms 45' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', within(popup).getByRole('list').id);

    act(() => toggle.focus());
    fireEvent.click(toggle);
    expect(within(popup).getAllByRole('listitem')).toHaveLength(55);
    expect(within(popup).getByText('user54@example.com')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('com_ui_dlp_show_fewer_terms');
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    expect(within(popup).getAllByRole('listitem')).toHaveLength(10);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(toggle, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: EMAIL_WARN })).not.toBeInTheDocument();
    expect(badge).toHaveFocus();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps expansion separate for each file finding badge', () => {
    renderDialog(
      {
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
      },
      'Summarize',
    );
    fireEvent.click(screen.getByRole('button', { name: EMAIL_WARN }));
    const first = screen.getByRole('dialog', { name: EMAIL_WARN });
    fireEvent.click(within(first).getByRole('button', { name: 'com_ui_dlp_show_all_terms 45' }));

    fireEvent.mouseEnter(screen.getByRole('button', { name: PROJECT_MASK }));
    const second = screen.getByRole('dialog', { name: PROJECT_MASK });
    expect(within(first).getAllByRole('listitem')).toHaveLength(55);
    expect(within(second).getAllByRole('listitem')).toHaveLength(10);
  });

  describe('keyboard', () => {
    const renderDecision = (decision: 'MASK' | 'BLOCK') =>
      renderDialog({
        decision,
        findings: [finding({ action: decision })],
        maskedRanges: maskedAt(),
      });
    const dialog = () => screen.getByRole('dialog', { name: 'com_ui_dlp_title' });

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
      fireEvent.keyDown(markOf('Project Acme'), { key: 'Enter' });
      expect(onConfirm).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(screen.getByRole('button', { name: 'com_ui_cancel' }), { key: 'Enter' });
      fireEvent.keyDown(screen.getByRole('button', { name: 'com_ui_dlp_show_masked' }), {
        key: 'Enter',
      });
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

    it('never sends a blocked prompt', () => {
      const { onCancel, onConfirm } = renderDecision('BLOCK');

      fireEvent.keyDown(dialog(), { key: 'Enter' });
      expect(onConfirm).not.toHaveBeenCalled();

      fireEvent.keyDown(dialog(), { key: 'Escape' });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('popup of a file finding badge', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const renderFileFinding = (terms = ['max@example.com']) =>
      renderDialog(
        {
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
        },
        'Summarize',
      );
    const popup = () => screen.queryByRole('dialog', { name: EMAIL_WARN });
    const send = () => screen.getByRole('button', { name: 'com_ui_dlp_send_anyway' });
    const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms));

    it('opens on hover without taking focus, and closes when the pointer leaves', () => {
      renderFileFinding();
      const badge = screen.getByRole('button', { name: EMAIL_WARN });
      expect(send()).toHaveFocus();

      fireEvent.mouseEnter(badge);
      expect(popup()).toBeInTheDocument();
      expect(send()).toHaveFocus();

      fireEvent.mouseLeave(badge);
      fireEvent.mouseEnter(popup() as HTMLElement);
      wait(500);
      expect(popup()).toBeInTheDocument();

      fireEvent.mouseLeave(popup() as HTMLElement);
      wait(500);
      expect(popup()).not.toBeInTheDocument();
      expect(send()).toHaveFocus();
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
      const { onCancel } = renderFileFinding();
      const badge = screen.getByRole('button', { name: EMAIL_WARN });

      badge.focus();
      fireEvent.click(badge);
      expect(popup()).toBeInTheDocument();
      expect(badge).toHaveFocus();

      fireEvent.keyDown(badge, { key: 'Escape' });
      expect(popup()).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'com_ui_dlp_title' })).toBeInTheDocument();
      expect(onCancel).not.toHaveBeenCalled();
      expect(badge).toHaveFocus();
    });

    it('keeps the popup open when its expansion button gains focus or is clicked', () => {
      const { onCancel } = renderFileFinding(
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
      const { onCancel } = renderFileFinding(
        Array.from({ length: 12 }, (_, i) => `user${i}@example.com`),
      );
      const badge = screen.getByRole('button', { name: EMAIL_WARN });
      badge.focus();
      fireEvent.click(badge);
      const content = popup() as HTMLElement;
      const toggle = within(content).getByRole('button', { name: 'com_ui_dlp_show_all_terms 2' });
      expect(content.closest('[role="document"]')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'com_ui_dlp_title' })).toContainElement(content);

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
      const { onCancel } = renderFileFinding();
      const badge = screen.getByRole('button', { name: EMAIL_WARN });
      fireEvent.mouseEnter(badge);
      expect(send()).toHaveFocus();

      fireEvent.keyDown(send(), { key: 'Escape' });
      expect(popup()).not.toBeInTheDocument();
      expect(badge).toHaveFocus();
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  it('falls back to a readable label for a built-in category without its own copy', () => {
    renderDialog({
      decision: 'WARN',
      findings: [finding({ category: 'US_PASSPORT', action: 'WARN', replacement: undefined })],
    });

    expect(
      within(markOf('Project Acme')).getByText('(Us passport · com_ui_dlp_decision_warn)'),
    ).toHaveClass('sr-only');
  });

  it('shows custom categories by their display names, never by their keys', () => {
    renderDialog(
      {
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
        ],
        maskedRanges: [
          { start: 0, end: 7, finding: 0 },
          { start: 12, end: 19, finding: 1 },
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
      },
      'Phoenix for Contoso',
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_dlp_show_masked' }));
    expect(promptRegion('com_ui_dlp_masked_prompt')).toHaveTextContent(
      '[Project Names] (Project Names · com_ui_dlp_decision_mask) for ' +
        '[Client Names] (Client Names · com_ui_dlp_decision_mask)',
    );
    expect(screen.getByText('Project Names · com_ui_dlp_decision_mask × 2')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('CUSTOM_');
  });

  it('shows a generic label for a custom category without display name', () => {
    renderDialog({
      decision: 'WARN',
      findings: [finding({ category: PROJECTS, action: 'WARN', replacement: undefined })],
      fileFindings: [{ filename: 'notes.txt', category: CLIENTS, action: 'WARN', count: 1 }],
    });

    expect(
      within(markOf('Project Acme')).getByText(
        '(com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn)',
      ),
    ).toHaveClass('sr-only');
    expect(
      screen.getAllByText('com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn'),
    ).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain('CUSTOM_');
  });
});
