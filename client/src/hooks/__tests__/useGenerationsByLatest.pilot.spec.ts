import { EModelEndpoint } from 'librechat-data-provider';
import useGenerationsByLatest from '../useGenerationsByLatest';

const latest = {
  endpoint: EModelEndpoint.custom,
  messageId: 'reply',
  latestMessageId: 'reply',
  finish_reason: 'length',
  isSubmitting: false,
};

it('hides editing, regeneration and continuation in governed chat', () => {
  expect(useGenerationsByLatest({ ...latest, governancePilot: true })).toMatchObject({
    isEditableEndpoint: false,
    hideEditButton: true,
    regenerateEnabled: false,
    continueSupported: false,
  });
});

it('retains upstream controls outside the pilot', () => {
  expect(useGenerationsByLatest(latest)).toMatchObject({
    isEditableEndpoint: true,
    hideEditButton: false,
    regenerateEnabled: true,
    continueSupported: true,
  });
});
