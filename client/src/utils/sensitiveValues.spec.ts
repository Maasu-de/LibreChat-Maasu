import type { TMessage } from 'librechat-data-provider';
import { countSensitiveValuesInMessages, maskSensitiveValues } from './sensitiveValues';

const createMessage = (text: string, isCreatedByUser = true, children?: TMessage[]): TMessage => ({
  messageId: crypto.randomUUID(),
  conversationId: 'conversation-id',
  parentMessageId: null,
  isCreatedByUser,
  text,
  children,
});

describe('sensitiveValues', () => {
  it('masks supported sensitive values and returns their count', () => {
    const result = maskSensitiveValues(
      'Email me@example.com, phone +49 170 1234567, and password=supersecret.',
    );

    expect(result.count).toBe(3);
    expect(result.maskedText).toBe('Email [MASKED], phone [MASKED], and [MASKED].');
  });

  it('returns zero for an empty conversation', () => {
    expect(countSensitiveValuesInMessages(null)).toBe(0);
    expect(countSensitiveValuesInMessages([])).toBe(0);
  });

  it('counts only user-authored messages on the displayed path', () => {
    const messages = [
      createMessage('user@example.com', true, [
        createMessage('assistant@example.com', false, [createMessage('password=hunter22')]),
      ]),
    ];

    expect(countSensitiveValuesInMessages(messages)).toBe(2);
  });
});
