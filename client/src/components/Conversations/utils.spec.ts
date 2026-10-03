import { getConversationDisplayTitle } from './utils';

describe('getConversationDisplayTitle', () => {
  it('uses New Chat when the title is empty', () => {
    expect(getConversationDisplayTitle('')).toBe('New Chat');
    expect(getConversationDisplayTitle(null)).toBe('New Chat');
    expect(getConversationDisplayTitle(undefined)).toBe('New Chat');
    expect(getConversationDisplayTitle('   ')).toBe('New Chat');
  });

  it('preserves a generated title', () => {
    expect(getConversationDisplayTitle('Project planning')).toBe('Project planning');
    expect(getConversationDisplayTitle('  Weekly sprint review  ')).toBe('Weekly sprint review');
  });
});
