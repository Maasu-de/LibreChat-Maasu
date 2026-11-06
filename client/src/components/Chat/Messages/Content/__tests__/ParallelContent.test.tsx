import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import type { TMessageContentParts, TParallelFeedback } from 'librechat-data-provider';
import { ParallelContentRenderer } from '../ParallelContent';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  SearchContext: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
}));

jest.mock('../SiblingHeader', () => ({
  __esModule: true,
  default: ({ agentId }: { agentId: string }) => <div data-testid={`header-${agentId}`} />,
}));

jest.mock('~/components/Web/Sources', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../MemoryArtifacts', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../Parts', () => ({
  EmptyText: () => <div data-testid="empty-text" />,
}));

const first = 'openAI__gpt-4.1___GPT-4.1';
const second = 'anthropic__claude-3.5___Claude____1';

const content = [
  { type: 'text', text: 'First answer', agentId: first, groupId: 1 },
  { type: 'text', text: 'Second answer', agentId: second, groupId: 1 },
] as unknown as TMessageContentParts[];

const renderColumns = (
  props: Partial<React.ComponentProps<typeof ParallelContentRenderer>> = {},
) =>
  render(
    <ParallelContentRenderer
      isLast
      messageId="msg-1"
      content={content}
      isSubmitting={false}
      renderPart={(part, idx) => <div key={idx}>{(part as { text: string }).text}</div>}
      {...props}
    />,
  );

const columnFeedback = (agentId: string) => within(screen.getByTestId(`column-feedback-${agentId}`));

describe('ParallelContentRenderer feedback', () => {
  it('rates each comparison response on its own', async () => {
    const onParallelFeedback = jest.fn();
    const parallelFeedback: TParallelFeedback[] = [
      { agentId: first, rating: 'thumbsUp', tag: 'accurate_reliable' },
      { agentId: second, rating: 'thumbsUp', tag: 'accurate_reliable' },
    ];
    renderColumns({ onParallelFeedback, parallelFeedback });

    await userEvent.click(columnFeedback(second).getByTitle('com_ui_feedback_positive'));

    expect(onParallelFeedback).toHaveBeenCalledTimes(1);
    expect(onParallelFeedback).toHaveBeenCalledWith(second, undefined);
    expect(columnFeedback(first).getByTitle('com_ui_feedback_positive')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it("shows each response's saved rating in its own column", () => {
    const parallelFeedback: TParallelFeedback[] = [
      { agentId: second, rating: 'thumbsDown', tag: 'not_helpful' },
    ];
    renderColumns({ onParallelFeedback: jest.fn(), parallelFeedback });

    expect(columnFeedback(second).getByTitle('com_ui_feedback_negative')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(columnFeedback(second).queryByTitle('com_ui_feedback_positive')).toBeNull();
    expect(columnFeedback(first).getByTitle('com_ui_feedback_positive')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(columnFeedback(first).getByTitle('com_ui_feedback_negative')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it.each([
    ['while the responses stream', { onParallelFeedback: jest.fn(), isSubmitting: true }],
    ['without a feedback handler', {}],
  ])('shows no feedback controls %s', (_label, props) => {
    renderColumns(props);

    expect(screen.queryByTestId(`column-feedback-${first}`)).toBeNull();
    expect(screen.queryByTestId(`column-feedback-${second}`)).toBeNull();
  });
});
