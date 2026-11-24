import React from 'react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, dataService, QueryKeys } from 'librechat-data-provider';
import { render, screen, waitFor, within } from 'test/layout-test-utils';
import DeleteMessage from '../DeleteMessage';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, deleteMessage: jest.fn() } };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

it('deletes only after confirmation and preserves the remaining conversation in cache', async () => {
  const deleteMessage = jest.mocked(dataService.deleteMessage).mockResolvedValue(undefined);
  const queryClient = new QueryClient();
  const key = [QueryKeys.messages, 'conversation'];
  queryClient.setQueryData(key, [
    { messageId: 'parent', parentMessageId: Constants.NO_PARENT },
    { messageId: 'selected', parentMessageId: 'parent' },
    { messageId: 'reply', parentMessageId: 'selected' },
  ]);
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <DeleteMessage conversationId="conversation" messageId="selected" />
    </QueryClientProvider>,
  );

  await user.click(screen.getByRole('button', { name: 'com_ui_message_delete_title' }));
  expect(deleteMessage).not.toHaveBeenCalled();
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'com_ui_delete' }),
  );

  await waitFor(() =>
    expect(queryClient.getQueryData(key)).toEqual([
      { messageId: 'parent', parentMessageId: Constants.NO_PARENT },
      { messageId: 'reply', parentMessageId: 'parent' },
    ]),
  );
  expect(deleteMessage).toHaveBeenCalledWith('conversation', 'selected');
});
