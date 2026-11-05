import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { GovernanceMaskedSpan, TMessage } from 'librechat-data-provider';
import MaskedText, { getMaskedSegments } from '../MaskedText';
import MessageContent from '../MessageContent';
import MarkdownLite from '../MarkdownLite';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useMessageContext: () => ({ isSubmitting: false, isLatestMessage: false }),
}));

jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('../MarkdownLite', () => ({
  __esModule: true,
  default: jest.fn(({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  )),
}));

const TEXT = '🙂 Mail [EMAIL] or [EMAIL]\nthanks';
const MASKS: GovernanceMaskedSpan[] = [
  { start: 7, end: 14, category: 'EMAIL_ADDRESS', replacement: '[EMAIL]' },
  { start: 18, end: 25, category: 'EMAIL_ADDRESS', replacement: '[EMAIL]' },
];

const userMessage = (text: string, dlpMasks?: GovernanceMaskedSpan[]): TMessage => ({
  messageId: 'message-1',
  conversationId: 'conversation-1',
  parentMessageId: null,
  isCreatedByUser: true,
  sender: 'User',
  text,
  dlpMasks,
});

const renderMessage = (message: TMessage, enableUserMsgMarkdown = true) =>
  render(
    <RecoilRoot
      initializeState={({ set }) => set(store.enableUserMsgMarkdown, enableUserMsgMarkdown)}
    >
      <MessageContent
        text={message.text}
        edit={false}
        error={false}
        unfinished={false}
        isSubmitting={false}
        isLast={false}
        message={message}
        isCreatedByUser={message.isCreatedByUser}
        ask={jest.fn()}
        enterEdit={jest.fn()}
        siblingIdx={0}
        setSiblingIdx={jest.fn()}
      />
    </RecoilRoot>,
  );

describe('getMaskedSegments', () => {
  it('splits the text at its masks, counting code points', () => {
    expect(getMaskedSegments(TEXT, MASKS)).toEqual([
      { text: '🙂 Mail ' },
      { text: '[EMAIL]', mask: MASKS[0] },
      { text: ' or ' },
      { text: '[EMAIL]', mask: MASKS[1] },
      { text: '\nthanks' },
    ]);
  });

  it('gives nothing without masks', () => {
    expect(getMaskedSegments(TEXT)).toBeUndefined();
    expect(getMaskedSegments(TEXT, [])).toBeUndefined();
  });

  it('gives nothing once the text no longer holds a replacement where its mask says', () => {
    expect(getMaskedSegments('🙂 Mail max@example.com or [EMAIL]', MASKS)).toBeUndefined();
    expect(getMaskedSegments('🙂 Mail [EMAIL]', MASKS)).toBeUndefined();
  });

  it('gives nothing for masks out of order or without text', () => {
    expect(getMaskedSegments(TEXT, [MASKS[1], MASKS[0]])).toBeUndefined();
    expect(
      getMaskedSegments(TEXT, [{ start: 7, end: 7, category: 'EMAIL_ADDRESS', replacement: '' }]),
    ).toBeUndefined();
  });
});

describe('MaskedText', () => {
  it('sets each replacement as a bar that names its category, with nothing to reveal', () => {
    const segments = getMaskedSegments(TEXT, MASKS) ?? [];
    const { container } = render(<MaskedText segments={segments} />);

    const bars = container.querySelectorAll('mark');
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar).toHaveTextContent('com_ui_dlp_category_email_address (com_ui_dlp_decision_mask)');
      expect(bar).toHaveClass('bg-text-primary', 'text-surface-primary');
      expect(bar).not.toHaveAttribute('tabindex');
    }
    expect(container).toHaveTextContent(
      /^🙂 Mail com_ui_dlp_category_email_address.* or com_ui_dlp_category_email_address.*thanks$/,
    );
    expect(container).not.toHaveTextContent('[EMAIL]');
  });

  it('shows each custom category label while keeping a shared replacement in the stored text', () => {
    const text = '[REDACTED] or [REDACTED]';
    const masks: GovernanceMaskedSpan[] = [
      {
        start: 0,
        end: 10,
        category: 'CUSTOM_codenames',
        label: 'Codenames',
        replacement: '[REDACTED]',
      },
      {
        start: 14,
        end: 24,
        category: 'CUSTOM_clients',
        label: 'Client names',
        replacement: '[REDACTED]',
      },
    ];
    const segments = getMaskedSegments(text, masks) ?? [];
    const { container } = render(<MaskedText segments={segments} />);

    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    expect(container.querySelectorAll('mark')[0]).toHaveTextContent('Codenames');
    expect(container.querySelectorAll('mark')[1]).toHaveTextContent('Client names');
    expect(container).not.toHaveTextContent('[REDACTED]');
    expect(container).not.toHaveTextContent('CUSTOM_');
  });

  it('gives older custom masks without labels a readable category fallback', () => {
    const text = '[REDACTED]';
    const segments =
      getMaskedSegments(text, [
        { start: 0, end: 10, category: 'CUSTOM_legacy', replacement: text },
      ]) ?? [];
    const { container } = render(<MaskedText segments={segments} />);

    expect(container.querySelector('mark')).toHaveTextContent('com_ui_dlp_category_custom_term');
    expect(container).not.toHaveTextContent('CUSTOM_legacy');
  });
});

describe('MessageContent with masks', () => {
  it('keeps Markdown enabled for masked user messages', () => {
    const { container } = renderMessage(userMessage(TEXT, MASKS));

    expect(screen.getByTestId('markdown')).toHaveTextContent('Mail [EMAIL] or [EMAIL]');
    expect(jest.mocked(MarkdownLite).mock.calls[0][0]).toEqual({
      content: TEXT,
      maskedSegments: getMaskedSegments(TEXT, MASKS),
    });
    expect(container.querySelector('.message-content')).not.toHaveClass('whitespace-pre-wrap');
  });

  it('shows plain text with bars when user Markdown is disabled', () => {
    const { container } = renderMessage(userMessage(TEXT, MASKS), false);

    expect(container.querySelectorAll('mark')).toHaveLength(2);
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();
    expect(container.querySelector('.message-content')).toHaveClass('whitespace-pre-wrap');
  });

  it('shows a user message as written when its masks no longer match its text', () => {
    const edited = 'Mail max@example.com instead';
    const { container } = renderMessage(userMessage(edited, MASKS));

    expect(container.querySelector('mark')).toBeNull();
    expect(screen.getByTestId('markdown')).toHaveTextContent(edited);
  });

  it('shows a user message without masks as before', () => {
    const { container } = renderMessage(userMessage(TEXT));

    expect(container.querySelector('mark')).toBeNull();
    expect(screen.getByTestId('markdown')).toHaveTextContent('Mail [EMAIL] or [EMAIL]');
  });
});
