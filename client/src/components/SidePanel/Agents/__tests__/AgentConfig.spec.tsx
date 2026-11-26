import React from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentForm } from '~/common';
import { getDefaultAgentFormValues } from '~/utils';
import { useLocalize } from '~/hooks';
import AgentConfig from '../AgentConfig';

let mockGovernancePilot = true;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { governancePilotEnabled: mockGovernancePilot } }),
  useListSkillsQuery: () => ({}),
  useGetAgentFiles: () => ({}),
}));

jest.mock('~/Providers', () => ({
  useFileMapContext: () => ({}),
  useAgentPanelContext: () => ({ agentsConfig: { capabilities: [] } }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useVisibleTools: () => ({ toolIds: [], mcpServerNames: [] }),
  useHasAccess: () => false,
  useAgentCategories: () => ({ categories: [{ value: 'general', label: 'General' }] }),
}));

jest.mock('~/components/Tools', () => ({
  ToolSelectDialog: () => null,
  MCPToolSelectDialog: () => null,
}));

jest.mock('~/components/Skills/dialogs', () => ({ SkillSelectDialog: () => null }));
jest.mock('../AgentAvatar', () => () => <div data-testid="avatar-control" />);
jest.mock('../Instructions', () => () => null);

function ConfigForm({
  values,
  onSave,
}: {
  values: Partial<AgentForm>;
  onSave: (data: AgentForm) => void;
}) {
  const localize = useLocalize();
  const methods = useForm<AgentForm>({
    defaultValues: { ...getDefaultAgentFormValues(), name: 'Agent', ...values },
  });
  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSave)}>
        <AgentConfig />
        <button type="submit">{localize('com_ui_save')}</button>
      </form>
    </FormProvider>
  );
}

function renderConfig(values: Partial<AgentForm> = {}, onSave = jest.fn()) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfigForm values={values} onSave={onSave} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockGovernancePilot = true;
});

it('hides private builder metadata and avatar uploads while preserving existing form values', async () => {
  const onSave = jest.fn();
  const values = {
    id: 'agent_private',
    category: 'finance',
    support_contact: { name: 'Support Team', email: 'support@example.com' },
  };
  renderConfig(values, onSave);

  expect(screen.queryByTestId('avatar-control')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_category')).not.toBeInTheDocument();
  expect(screen.queryByText(values.id)).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_support_contact')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('com_ui_support_contact_name')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('com_ui_support_contact_email')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave.mock.calls[0][0]).toMatchObject(values);
});

it('submits General as the default category for new private agents', async () => {
  const onSave = jest.fn();
  renderConfig({}, onSave);

  fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave.mock.calls[0][0].category).toBe('general');
});

it('retains metadata and avatar controls outside governed deployments', () => {
  mockGovernancePilot = false;
  renderConfig({ id: 'agent_standard' });

  expect(screen.getByTestId('avatar-control')).toBeInTheDocument();
  expect(screen.getByText('com_ui_category')).toBeInTheDocument();
  expect(screen.getByText('agent_standard')).toBeInTheDocument();
  expect(screen.getByLabelText('com_ui_support_contact_name')).toBeInTheDocument();
  expect(screen.getByLabelText('com_ui_support_contact_email')).toBeInTheDocument();
});
