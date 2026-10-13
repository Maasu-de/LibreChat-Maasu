import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { FileSources } from 'librechat-data-provider';
import type { ExtendedFile, TPendingDlpReview } from '~/common';
import useDeleteUnsentDlpFiles from '../useDeleteUnsentDlpFiles';
import store from '~/store';

const mockDeleteFiles = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      deleteFiles: (...args: unknown[]) => mockDeleteFiles(...args),
    },
  };
});

const upload = (file_id: string): ExtendedFile => ({
  file_id,
  temp_file_id: `temp-${file_id}`,
  filepath: `/uploads/${file_id}`,
  source: FileSources.local,
  size: 10,
  progress: 1,
});
const libraryFile: ExtendedFile = {
  file_id: 'library',
  filepath: '/uploads/library',
  source: FileSources.local,
  size: 10,
  progress: 1,
  attached: true,
};

const review = (status?: TPendingDlpReview['status']): TPendingDlpReview => ({
  text: 'Please email max@example.com today',
  conversationId: null,
  files: [{ file_id: 'upload' }, { file_id: 'library' }],
  result: { reviewId: 'review-1', decision: 'MASK', findings: [] },
  status,
});

function renderWithReview(pending: TPendingDlpReview) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.conversationKeysAtom, [0]);
        set(store.dlpReviewByIndex(0), pending);
        set(
          store.submittedFilesByIndex(0),
          new Map([
            ['temp-upload', upload('upload')],
            ['library', libraryFile],
          ]),
        );
      }}
    >
      {children}
    </RecoilRoot>
  );
  return renderHook(() => useDeleteUnsentDlpFiles(), { wrapper });
}

beforeEach(() => {
  mockDeleteFiles.mockReset().mockResolvedValue({ message: 'deleted', result: {} });
});

it('deletes the uploads of an undecided review, but not library files', async () => {
  const { result } = renderWithReview(review());

  await act(() => result.current());

  expect(mockDeleteFiles).toHaveBeenCalledWith({
    files: [
      {
        file_id: 'upload',
        filepath: '/uploads/upload',
        source: FileSources.local,
        embedded: false,
      },
    ],
  });
});

it('keeps the files of a review whose approved turn is on its way', async () => {
  const { result } = renderWithReview(review('sending'));

  await act(() => result.current());

  expect(mockDeleteFiles).not.toHaveBeenCalled();
});
