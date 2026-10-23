import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GovernanceFinding } from 'librechat-data-provider';
import DlpInterventionDialog, {
  buildFindingSegments,
  buildReplacementSegments,
} from '../DlpInterventionDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const PROJECTS = 'CUSTOM_8F14E45FCEEA167A5A36DEDD4BEA2543';
const CLIENTS = 'CUSTOM_C9F0F895FB98AB9159F51FD0297E236D';

const finding = (overrides: Partial<GovernanceFinding> = {}): GovernanceFinding => ({
  location: '/messages/0/content',
  start: 8,
  end: 20,
  category: 'PROJECT_NAME',
  action: 'MASK',
  replacement: '[CONFIDENTIAL]',
  ...overrides,
});

describe('DLP intervention text segmentation', () => {
  it('keeps sensitive original text separate from surrounding text', () => {
    const segments = buildFindingSegments('Discuss Project Acme now', [finding()]);

    expect(segments.map((segment) => segment.text)).toEqual(['Discuss ', 'Project Acme', ' now']);
    expect(segments[1].finding?.category).toBe('PROJECT_NAME');
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

    expect(screen.getByText('Project Acme')).toBeInTheDocument();
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

    expect(
      screen.getByText('VAT ID · com_ui_dlp_decision_warn → [CONFIDENTIAL]'),
    ).toBeInTheDocument();
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

    expect(
      screen.getByText('Project Names · com_ui_dlp_decision_mask → [Project Names]'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Client Names · com_ui_dlp_decision_mask → [Client Names]'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('com_ui_dlp_category_email_address · com_ui_dlp_decision_mask → [EMAIL]'),
    ).toBeInTheDocument();
    expect(screen.getByText('Project Names · com_ui_dlp_decision_mask × 2')).toBeInTheDocument();
    expect(screen.getByText('[Project Names]')).toBeInTheDocument();
    expect(screen.getByText('[Client Names]')).toBeInTheDocument();
    expect(screen.getByTitle('Project Names')).toHaveTextContent('Phoenix');
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
      screen.getAllByText('com_ui_dlp_category_custom_term · com_ui_dlp_decision_warn'),
    ).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain('CUSTOM_');
  });
});
