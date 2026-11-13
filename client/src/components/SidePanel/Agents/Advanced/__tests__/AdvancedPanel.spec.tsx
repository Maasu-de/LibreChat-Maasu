import React from 'react';
import { render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { AgentForm } from '~/common';
import AdvancedPanel from '../AdvancedPanel';

let mockGovernancePilot = true;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: { governancePilotEnabled: mockGovernancePilot },
  }),
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({
    agentsConfig: { capabilities: [] },
    setActivePanel: jest.fn(),
  }),
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

function Builder() {
  const methods = useForm<AgentForm>({
    defaultValues: { id: 'agent_test', edges: [] },
  });

  return (
    <FormProvider {...methods}>
      <AdvancedPanel />
    </FormProvider>
  );
}

it('hides agent handoffs in the governed model-only builder', () => {
  mockGovernancePilot = true;
  render(<Builder />);

  expect(screen.queryByText('com_ui_agent_handoffs')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_agent_handoff_add')).not.toBeInTheDocument();
  expect(screen.getByText('com_ui_agent_recursion_limit')).toBeInTheDocument();
});

it('preserves handoffs in the standalone builder with no optional capabilities', () => {
  mockGovernancePilot = false;
  render(<Builder />);

  expect(screen.getByText('com_ui_agent_handoffs')).toBeInTheDocument();
  expect(screen.getByText('com_ui_agent_handoff_add')).toBeInTheDocument();
});
