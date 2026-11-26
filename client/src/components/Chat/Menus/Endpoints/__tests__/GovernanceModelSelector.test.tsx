import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GOVERNANCE_ENDPOINT, QueryKeys } from 'librechat-data-provider';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import type { GovernanceModel } from 'librechat-data-provider';
import GovernanceModelSelector from '../GovernanceModelSelector';
import { groupGovernanceModels } from '../governance';

jest.mock('../../../../../../../packages/data-provider/src/data-service', () => ({
  ...jest.requireActual('../../../../../../../packages/data-provider/src/data-service'),
  getGovernanceModels: jest.fn(),
  getModels: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => {
    const translations = jest.requireActual('~/locales/en/translation.json');
    return (key: string) => translations[key] ?? key;
  },
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { governancePilotEnabled: true } }),
  useGetEndpointsQuery: () => ({ data: {} }),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/components/Endpoints', () => ({
  EndpointIcon: () => null,
}));

const models: GovernanceModel[] = [
  {
    id: 'sovereign-model',
    governance_tier: {
      code: 'S1',
      name: 'EU Sovereign',
      description: 'Models from European providers, hosted and processed within the EU.',
    },
  },
  {
    id: 'hosted-model',
    governance_tier: {
      code: 'S2',
      name: 'EU Hosted',
      description: 'Models from approved global providers, hosted and processed within the EU.',
    },
  },
];

function renderSelector(children: React.ReactNode, catalog = models) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData([QueryKeys.governanceModels], { [GOVERNANCE_ENDPOINT]: catalog });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe('governance model grouping', () => {
  it('maps each returned model exactly once and keeps existing identifiers', () => {
    const groups = groupGovernanceModels([models[1], models[0], models[0]]);
    expect(groups.map((group) => group.tier?.code)).toEqual(['S1', 'S2']);
    expect(groups.flatMap((group) => group.models.map((model) => model.id))).toEqual([
      'sovereign-model',
      'hosted-model',
    ]);
  });

  it('does not assign missing, invalid or incomplete tier metadata to a known tier', () => {
    const invalid = [
      { id: 'missing' },
      { id: 'null', governance_tier: null },
      { id: 'invalid', governance_tier: { code: 'S3', name: 'Other', description: 'Other' } },
      { id: 'incomplete', governance_tier: { code: 'S1', name: '', description: '' } },
    ];
    const groups = groupGovernanceModels(invalid);
    expect(groups).toEqual([{ tier: null, models: invalid }]);
    expect(groupGovernanceModels([])).toEqual([]);
  });
});

describe('GovernanceModelSelector', () => {
  it('lists saved agents directly with their configured model and separate model tiers', async () => {
    const onSelectAgent = jest.fn();
    const agent = { id: 'agent_governed', name: 'Research assistant', model: 'sovereign-model' };
    renderSelector(
      <GovernanceModelSelector
        endpoint={GOVERNANCE_ENDPOINT}
        value={null}
        agents={[agent]}
        selectedAgentId={agent.id}
        onSelectAgent={onSelectAgent}
        onSelect={jest.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));
    const agentSection = screen.getByRole('group', { name: 'My Agents' });
    const agentOption = within(agentSection).getByRole('option', {
      name: 'Research assistant sovereign-model',
    });
    expect(within(agentOption).getByText(agent.model)).toHaveClass('text-xs');
    expect(agentOption).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(agent.id)).not.toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    const modelSection = screen.getByRole('group', { name: 'Models' });
    expect(within(modelSection).getByRole('group', { name: 'EU Sovereign' })).toBeInTheDocument();
    expect(within(modelSection).getByRole('option', { name: agent.model })).not.toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(agentOption);
    expect(onSelectAgent).toHaveBeenCalledWith(agent.id);
  });

  it('searches both sections by agent name and configured model in the same picker', async () => {
    const onSelect = jest.fn();
    renderSelector(
      <GovernanceModelSelector
        endpoint={GOVERNANCE_ENDPOINT}
        value={null}
        agents={[
          { id: 'agent_research', name: 'Research assistant', model: 'sovereign-model' },
          { id: 'agent_writer', name: 'Writer', model: 'hosted-model' },
        ]}
        onSelectAgent={jest.fn()}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));
    const search = screen.getByRole('combobox', { name: 'Search agents and models...' });
    await userEvent.type(search, 'hosted');
    expect(screen.getByRole('option', { name: 'Writer hosted-model' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'hosted-model' })).toBeInTheDocument();
    expect(screen.queryByText('Research assistant')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'EU Sovereign' })).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'research');
    expect(
      screen.getByRole('option', { name: 'Research assistant sovereign-model' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Writer')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'sovereign-model' })).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'S2');
    expect(screen.queryByText('Research assistant')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'hosted-model' }));
    expect(onSelect).toHaveBeenCalledWith('hosted-model');
  });

  it.each(models)('renders both canonical tiers and selects $id unchanged', async ({ id }) => {
    const onSelect = jest.fn();
    renderSelector(
      <GovernanceModelSelector endpoint={GOVERNANCE_ENDPOINT} value={null} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));

    for (const model of models) {
      const tier = model.governance_tier!;
      const group = await screen.findByRole('group', { name: tier.name });
      expect(within(group).getByRole('heading', { name: tier.name })).toBeInTheDocument();
      expect(within(group).queryByRole('option', { name: tier.name })).not.toBeInTheDocument();
      expect(within(group).getByRole('option', { name: model.id })).toBeInTheDocument();
    }
    expect(screen.queryByText(/S[12] —/)).not.toBeInTheDocument();
    expect(screen.queryByText('gemini-3.6-flash')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: id }));
    expect(onSelect).toHaveBeenCalledWith(id);
  });

  it('shows tier descriptions on heading hover without selecting a model', async () => {
    const onSelect = jest.fn();
    renderSelector(
      <GovernanceModelSelector endpoint={GOVERNANCE_ENDPOINT} value={null} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    for (const [index, model] of models.entries()) {
      const tier = model.governance_tier!;
      const heading = screen.getByRole('heading', { name: tier.name });
      await userEvent.hover(heading);
      fireEvent.mouseMove(heading, { screenX: index + 1, screenY: index + 1 });
      expect(await screen.findByRole('tooltip', {}, { timeout: 3000 })).toHaveTextContent(
        tier.description,
      );
      await userEvent.unhover(heading);
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    }

    await userEvent.click(screen.getByRole('heading', { name: 'EU Sovereign' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: 'sovereign-model' })).toBeInTheDocument();
  });

  it('shows unavailable metadata explicitly and filters models without dropping tier headings', async () => {
    renderSelector(
      <GovernanceModelSelector endpoint={GOVERNANCE_ENDPOINT} value={null} onSelect={jest.fn()} />,
      [...models, { id: 'unclassified' }],
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));
    const unknown = await screen.findByRole('group', { name: 'Tier unavailable' });
    expect(within(unknown).getByRole('option', { name: 'unclassified' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox'), 'hosted');
    expect(screen.getByRole('heading', { name: 'EU Hosted' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'sovereign-model' })).not.toBeInTheDocument();
  });

  it('retries an empty catalog and shows models when the gateway recovers', async () => {
    const { getGovernanceModels } = jest.requireMock(
      '../../../../../../../packages/data-provider/src/data-service',
    ) as { getGovernanceModels: jest.Mock };
    getGovernanceModels
      .mockReset()
      .mockResolvedValueOnce({ [GOVERNANCE_ENDPOINT]: [] })
      .mockResolvedValueOnce({ [GOVERNANCE_ENDPOINT]: models });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData([QueryKeys.models], {
      [GOVERNANCE_ENDPOINT]: ['old-model'],
      Other: ['other-model'],
    });
    render(
      <QueryClientProvider client={client}>
        <GovernanceModelSelector endpoint={GOVERNANCE_ENDPOINT} value={null} onSelect={jest.fn()} />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'EU Sovereign' })).toBeInTheDocument();
    expect(getGovernanceModels).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(client.getQueryData([QueryKeys.models])).toEqual({
        [GOVERNANCE_ENDPOINT]: ['sovereign-model', 'hosted-model'],
        Other: ['other-model'],
      }),
    );
  });

  it('keeps gateway identifiers from the tier catalog when the regular model list refreshes', async () => {
    const { getModels } = jest.requireMock(
      '../../../../../../../packages/data-provider/src/data-service',
    ) as { getModels: jest.Mock };
    getModels.mockResolvedValue({
      [GOVERNANCE_ENDPOINT]: ['old-model'],
      Other: ['other-model'],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData([QueryKeys.governanceModels], { [GOVERNANCE_ENDPOINT]: models });

    function ModelsQuery() {
      useGetModelsQuery({ refetchOnMount: 'always' });
      return null;
    }
    render(
      <QueryClientProvider client={client}>
        <ModelsQuery />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getModels).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(client.getQueryData([QueryKeys.models])).toMatchObject({
        [GOVERNANCE_ENDPOINT]: ['sovereign-model', 'hosted-model'],
        Other: ['other-model'],
      }),
    );
  });
});
