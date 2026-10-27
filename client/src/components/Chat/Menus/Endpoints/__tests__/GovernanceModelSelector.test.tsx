import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GOVERNANCE_ENDPOINT, QueryKeys } from 'librechat-data-provider';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import type { EModelEndpoint, GovernanceModel, TConversation } from 'librechat-data-provider';
import GovernanceModelSelector from '../GovernanceModelSelector';
import AddedConvo from '~/components/Chat/Input/AddedConvo';
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
  it.each(models)('renders both canonical tiers and selects $id unchanged', async ({ id }) => {
    const onSelect = jest.fn();
    renderSelector(
      <GovernanceModelSelector endpoint={GOVERNANCE_ENDPOINT} value={null} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));

    for (const model of models) {
      const tier = model.governance_tier!;
      const group = await screen.findByRole('group', { name: `${tier.code} — ${tier.name}` });
      expect(within(group).getByRole('heading')).toHaveTextContent(`${tier.code} — ${tier.name}`);
      expect(within(group).getByText(tier.description)).toBeInTheDocument();
      expect(within(group).getByRole('option', { name: model.id })).toBeInTheDocument();
    }
    expect(screen.queryByText('gemini-3.6-flash')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: id }));
    expect(onSelect).toHaveBeenCalledWith(id);
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
    expect(screen.getByRole('heading', { name: 'S2 — EU Hosted' })).toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'S1 — EU Sovereign' })).toBeInTheDocument();
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

  it('uses the same options in the comparison selector and passes the selected identifier', async () => {
    const setAddedConvo = jest.fn();
    const conversation: TConversation = {
      conversationId: null,
      title: 'New Chat',
      createdAt: '',
      updatedAt: '',
      endpoint: GOVERNANCE_ENDPOINT as EModelEndpoint,
      model: 'sovereign-model',
    };
    renderSelector(<AddedConvo addedConvo={conversation} setAddedConvo={setAddedConvo} />);
    await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));
    expect(await screen.findByRole('heading', { name: 'S1 — EU Sovereign' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'S2 — EU Hosted' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'hosted-model' }));
    expect(setAddedConvo).toHaveBeenCalledTimes(1);
    const update = setAddedConvo.mock.calls[0][0] as (
      previous: TConversation | null,
    ) => TConversation | null;
    expect(update(conversation)).toEqual({ ...conversation, model: 'hosted-model' });
    expect(update(null)).toBeNull();
  });
});
