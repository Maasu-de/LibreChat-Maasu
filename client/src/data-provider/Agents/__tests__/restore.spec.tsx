import React from 'react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, request, EModelEndpoint, GOVERNANCE_ENDPOINT } from 'librechat-data-provider';
import type { Agent, AgentListResponse } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import AgentSelect from '~/components/SidePanel/Agents/AgentSelect';
import VersionPanel from '~/components/SidePanel/Agents/Version/VersionPanel';
import { useLocalize } from '~/hooks';
import {
  useCreateAgentMutation,
  useRevertAgentVersionMutation,
  allAgentViewAndEditQueryKeys,
} from '../mutations';
import { useGetAgentByIdQuery, useGetExpandedAgentByIdQuery } from '../queries';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAgentDefaultPermissionLevel: () => 1,
}));

jest.mock('~/Providers/AgentPanelContext', () => ({
  useAgentPanelContext: () => ({ agent_id: 'agent_restore', setActivePanel: jest.fn() }),
}));

const currentAgent: Agent = {
  id: 'agent_restore',
  author: 'user_restore',
  created_at: 0,
  avatar: null,
  name: 'Current agent',
  description: 'Current description',
  instructions: 'Current instructions',
  provider: GOVERNANCE_ENDPOINT,
  model: 'current-model',
  model_parameters: {
    temperature: 0.7,
    maxContextTokens: 8192,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: 0.9,
    frequency_penalty: 0,
    presence_penalty: 0,
  },
  tools: [],
};

const restoredAgent: Agent = {
  ...currentAgent,
  name: 'Restored agent',
  description: 'Restored description',
  instructions: 'Restored instructions',
  model: 'historical-model',
  model_parameters: { ...currentAgent.model_parameters, temperature: 0.2 },
};

function Editor({ onSave }: { onSave: (data: AgentForm) => void }) {
  const localize = useLocalize();
  const methods = useForm<AgentForm>();
  const basicAgent = useGetAgentByIdQuery(currentAgent.id);
  const expandedAgent = useGetExpandedAgentByIdQuery(currentAgent.id);
  const agentQuery = expandedAgent.data ? expandedAgent : basicAgent;
  const createMutation = useCreateAgentMutation();
  const restoreMutation = useRevertAgentVersionMutation();
  const values = useWatch({ control: methods.control });

  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSave)}>
        <AgentSelect
          agentQuery={agentQuery}
          selectedAgentId={currentAgent.id}
          setCurrentAgentId={() => {}}
          createMutation={createMutation}
        />
        <output data-testid="editor-values">{JSON.stringify(values)}</output>
        <button
          type="button"
          onClick={() => restoreMutation.mutate({ agent_id: currentAgent.id, version_index: 0 })}
        >
          {localize('com_ui_agent_version_restore')}
        </button>
        <button type="submit">{localize('com_ui_save')}</button>
      </form>
    </FormProvider>
  );
}

it('rehydrates the expanded editor and its next save with the restored agent', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.agents]: {} });
  queryClient.setQueryData([QueryKeys.agent, currentAgent.id], currentAgent);
  queryClient.setQueryData([QueryKeys.agent, currentAgent.id, 'expanded'], currentAgent);
  const list: AgentListResponse = {
    object: 'list',
    data: [currentAgent],
    has_more: false,
    first_id: currentAgent.id,
    last_id: currentAgent.id,
  };
  for (const params of allAgentViewAndEditQueryKeys) {
    queryClient.setQueryData([QueryKeys.agents, params], list);
  }
  const restoreRequest = jest.spyOn(request, 'post').mockResolvedValue(restoredAgent);
  const onSave = jest.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <Editor onSave={onSave} />
    </QueryClientProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId('editor-values')).toHaveTextContent('Current instructions');
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_agent_version_restore' }));

  await waitFor(() => {
    expect(screen.getByTestId('editor-values')).toHaveTextContent('Restored instructions');
  });
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

  await waitFor(() => {
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: restoredAgent.name,
        description: restoredAgent.description,
        instructions: restoredAgent.instructions,
        provider: restoredAgent.provider,
        model: restoredAgent.model,
        model_parameters: restoredAgent.model_parameters,
      }),
      expect.anything(),
    );
  });
  expect(restoreRequest).toHaveBeenCalledWith(`/api/agents/${currentAgent.id}/revert`, {
    version_index: 0,
  });
  expect(queryClient.getQueryData([QueryKeys.agent, currentAgent.id])).toEqual(restoredAgent);
  for (const params of allAgentViewAndEditQueryKeys) {
    expect(queryClient.getQueryData([QueryKeys.agents, params])).toEqual({
      ...list,
      data: [restoredAgent],
    });
  }
});

it('loads fresh history and restores the selected settings-only version with duplicate timestamps', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const versions = [0.1, 0.2, 0.7].map((temperature) => ({
    ...currentAgent,
    model_parameters: { ...currentAgent.model_parameters, temperature },
    updatedAt: '2026-11-06T10:00:00Z',
  }));
  let persistedAgent = { ...currentAgent, versions };
  const historyRequest = jest.spyOn(request, 'get').mockImplementation(async () => persistedAgent);
  const restoreRequest = jest.spyOn(request, 'post').mockImplementation(async () => {
    persistedAgent = { ...persistedAgent, model_parameters: versions[1].model_parameters };
    return persistedAgent;
  });
  jest.spyOn(window, 'confirm').mockReturnValue(true);

  render(
    <QueryClientProvider client={queryClient}>
      <VersionPanel />
    </QueryClientProvider>,
  );

  const restoreButtons = await screen.findAllByRole('button', {
    name: 'com_ui_agent_version_restore',
  });
  expect(restoreButtons).toHaveLength(2);
  expect(screen.getAllByText('com_ui_agent_version_active')).toHaveLength(1);
  expect(historyRequest).toHaveBeenCalledWith(`/api/agents/${currentAgent.id}/expanded`);

  fireEvent.click(restoreButtons[1]);

  await waitFor(() => {
    expect(restoreRequest).toHaveBeenCalledWith(`/api/agents/${currentAgent.id}/revert`, {
      version_index: 1,
    });
    expect(queryClient.getQueryData([QueryKeys.agent, currentAgent.id, 'expanded'])).toEqual(
      persistedAgent,
    );
  });
});
