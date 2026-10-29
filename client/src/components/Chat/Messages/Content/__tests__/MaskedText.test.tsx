import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { GovernanceMaskedSpan, TMessage } from 'librechat-data-provider';
import MaskedText, { getMaskedSegments } from '../MaskedText';
import MessageContent from '../MessageContent';

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
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
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

const renderMessage = (message: TMessage) =>
  render(
    <RecoilRoot>
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
      expect(bar).toHaveTextContent(
        '[EMAIL] (com_ui_dlp_category_email_address · com_ui_dlp_decision_mask)',
      );
      expect(bar).toHaveClass('bg-text-primary', 'text-surface-primary');
      expect(bar).not.toHaveAttribute('tabindex');
    }
    expect(container).toHaveTextContent(/^🙂 Mail \[EMAIL\].* or \[EMAIL\].*thanks$/);
  });
});

describe('MessageContent with masks', () => {
  it('shows a masked user message as plain text with bars', () => {
    const { container } = renderMessage(userMessage(TEXT, MASKS));

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
