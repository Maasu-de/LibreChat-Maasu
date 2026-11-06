import React from 'react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import { EModelEndpoint, GOVERNANCE_ENDPOINT } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import AddMultiConvo from '../AddMultiConvo';
import { useLocalize } from '~/hooks';
import store from '~/store';

let mockGovernancePilot = true;
let mockConversation: TConversation;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetConversation: () => () => mockConversation,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { governancePilotEnabled: mockGovernancePilot } }),
}));

const classic: TConversation = {
  conversationId: null,
  title: 'New Chat',
  createdAt: '',
  updatedAt: '',
  endpoint: GOVERNANCE_ENDPOINT as EModelEndpoint,
  model: 'first-model',
};
const agent: TConversation = {
  ...classic,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_saved',
};

function ComparisonState() {
  const localize = useLocalize();
  const comparison = useRecoilValue(store.conversationByIndex(1));
  const setConversation = useSetRecoilState(store.conversationByIndex(0));
  return (
    <>
      <output data-testid="comparison">{JSON.stringify(comparison)}</output>
      <button type="button" onClick={() => setConversation(agent)}>
        {localize('com_ui_select_agent')}
      </button>
    </>
  );
}

function renderComparison(conversation: TConversation, comparison: TConversation | null = null) {
  mockConversation = conversation;
  return render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.conversationByIndex(0), conversation);
        set(store.conversationByIndex(1), comparison);
      }}
    >
      <AddMultiConvo />
      <ComparisonState />
    </RecoilRoot>,
  );
}

beforeEach(() => {
  mockGovernancePilot = true;
});

it('does not offer a comparison for a governed saved agent', () => {
  renderComparison(agent);

  expect(screen.queryByTestId('add-multi-convo-button')).toBeNull();
  expect(screen.getByTestId('comparison')).toHaveTextContent('null');
});

it('keeps classic governed two-model comparisons available', () => {
  renderComparison(classic);

  fireEvent.click(screen.getByTestId('add-multi-convo-button'));
  expect(JSON.parse(screen.getByTestId('comparison').textContent ?? '')).toEqual({
    ...classic,
    title: '',
  });
  expect(screen.queryByTestId('add-multi-convo-button')).toBeNull();
});

it('clears a classic comparison when the primary conversation switches to a governed agent', () => {
  renderComparison(classic, { ...classic, model: 'second-model' });

  fireEvent.click(screen.getByRole('button', { name: 'com_ui_select_agent' }));

  expect(screen.getByTestId('comparison')).toHaveTextContent('null');
  expect(screen.queryByTestId('add-multi-convo-button')).toBeNull();
});

it('preserves standalone agent comparisons', () => {
  mockGovernancePilot = false;
  renderComparison(agent);

  fireEvent.click(screen.getByTestId('add-multi-convo-button'));
  expect(JSON.parse(screen.getByTestId('comparison').textContent ?? '')).toEqual({
    ...agent,
    title: '',
  });
});
