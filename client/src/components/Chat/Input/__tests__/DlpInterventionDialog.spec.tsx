import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GovernanceFinding } from 'librechat-data-provider';
import i18n from '~/locales/i18n';
import DlpInterventionDialog, {
  buildFindingTerms,
  buildFindingSegments,
  buildReplacementSegments,
} from '../DlpInterventionDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

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

  it('lists every finding in text order with the whole term it covers', () => {
    const terms = buildFindingTerms(CROSSING, crossingFindings);

    expect(terms.map(({ term }) => term)).toEqual(['Project Phoenix', 'Phoenix Secret']);
  });

  it('uses Unicode code-point offsets supplied by the governance backend', () => {
    const segments = buildFindingSegments('🙂 Email me@example.com', [
      finding({ start: 8, end: 22, category: 'EMAIL_ADDRESS' }),
    ]);

    expect(segments[1].text).toBe('me@example.com');
  });

  it('visually separates replacement tokens in the complete masked prompt', () => {
    const segments = buildReplacementSegments('Discuss [CONFIDENTIAL] now', [finding()]);

    expect(segments).toEqual([
      { text: 'Discuss ', replacement: false },
      { text: '[CONFIDENTIAL]', replacement: true },
      { text: ' now', replacement: false },
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

    expect(screen.getAllByText('Project Acme')).toHaveLength(2);
    expect(screen.getByText('[CONFIDENTIAL]')).toBeInTheDocument();
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

    expect(
      screen.getByText('com_ui_dlp_category_project_name · com_ui_dlp_decision_block'),
    ).toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_continue')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_send_masked')).not.toBeInTheDocument();
  });

  it('names the compared models the findings do not allow, with only a close action', () => {
    const onCancel = jest.fn();

    render(
      <I18nextProvider i18n={i18n}>
        <DlpInterventionDialog
          result={{
            decision: 'BLOCK',
            findings: [finding({ action: 'MASK' })],
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
      "public-s2 can't receive prompts that contain: com_ui_dlp_category_project_name, CUSTOM TERM. Choose a different model or remove it from the comparison to continue with this prompt.",
    );
    expect(screen.queryByText('com_ui_dlp_block_title')).not.toBeInTheDocument();
    expect(screen.getByText('Project Acme', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_continue')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('com_ui_close'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('lists findings in attached files without a masked prompt when the text has none', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'MASK',
          findings: [],
          fileFindings: [
            { filename: 'report.pdf', category: 'IBAN_CODE', action: 'MASK', count: 2 },
            { filename: 'report.pdf', category: 'PHONE_NUMBER', action: 'WARN', count: 1 },
            { filename: 'notes.txt', category: 'EMAIL_ADDRESS', action: 'MASK', count: 1 },
          ],
          maskedPreview: [{ location: '/messages/0/content', text: 'Summarize' }],
        }}
        originalText="Summarize"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByText('com_ui_dlp_file_findings')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(
      screen.getByText('com_ui_dlp_category_iban_code · com_ui_dlp_decision_mask × 2'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('com_ui_dlp_category_phone_number · com_ui_dlp_decision_warn'),
    ).toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_findings')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_dlp_masked_prompt')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_dlp_send_masked')).toBeInTheDocument();
  });

  it('falls back to a readable label for an unknown finding category', () => {
    render(
      <DlpInterventionDialog
        result={{
          decision: 'WARN',
          findings: [finding({ category: 'CUSTOM_SECRET', action: 'WARN' })],
        }}
        originalText="Discuss Project Acme now"
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByText('CUSTOM SECRET · com_ui_dlp_decision_warn')).toBeInTheDocument();
    expect(screen.getByText('→ [CONFIDENTIAL]')).toBeInTheDocument();
  });

  it('names each overlapping term in full next to its replacement', () => {
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

    const terms = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(terms).toEqual([
      'com_ui_dlp_category_project_name · com_ui_dlp_decision_maskProject Phoenix→ [TERM]',
      'com_ui_dlp_category_project_name · com_ui_dlp_decision_maskPhoenix Secret→ [TERM]',
    ]);
    expect(screen.getByText('Phoenix', { selector: 'mark' })).toHaveAttribute(
      'title',
      'com_ui_dlp_category_project_name → [TERM]\ncom_ui_dlp_category_project_name → [TERM]',
    );
  });
});
