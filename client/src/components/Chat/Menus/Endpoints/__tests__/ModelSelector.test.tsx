import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import { EModelEndpoint, GOVERNANCE_ENDPOINT } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TStartupConfig } from 'librechat-data-provider';
import { useModelSelectorContext } from '../ModelSelectorContext';
import ModelSelector from '../ModelSelector';

jest.mock('../ModelSelectorContext', () => ({
  ModelSelectorProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useModelSelectorContext: jest.fn(),
}));

jest.mock('../ModelSelectorChatContext', () => ({
  ModelSelectorChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

jest.mock('../components', () => ({}));
jest.mock('../DialogManager', () => () => null);
jest.mock('../utils', () => ({
  getSelectedIcon: () => null,
  getDisplayValue: () => 'Research assistant',
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => {
    const translations = jest.requireActual('~/locales/en/translation.json');
    return (key: string) => translations[key] ?? key;
  },
}));

jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutHint: () => '',
  useShortcutAriaKey: () => '',
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useGetGovernanceModelsQuery: () => {
    const { GOVERNANCE_ENDPOINT } = jest.requireActual('librechat-data-provider');
    return { data: { [GOVERNANCE_ENDPOINT]: [{ id: 'sovereign-model' }] } };
  },
}));

it('routes direct agent and model choices through the existing endpoint selection handler', async () => {
  const handleSelectModel = jest.fn();
  const agentEndpoint = {
    value: EModelEndpoint.agents,
    label: 'Agents',
    hasModels: true,
    icon: null,
  };
  jest.mocked(useModelSelectorContext).mockReturnValue({
    agents: [
      {
        id: 'sovereign-model',
        name: 'Research assistant',
        description: null,
        avatar: null,
        created_at: 0,
        provider: EModelEndpoint.openAI,
        model: 'sovereign-model',
        model_parameters: {
          temperature: null,
          maxContextTokens: null,
          max_context_tokens: null,
          max_output_tokens: null,
          top_p: null,
          frequency_penalty: null,
          presence_penalty: null,
        },
      },
    ],
    agentsMap: {},
    modelSpecs: [],
    mappedEndpoints: [agentEndpoint],
    endpointsConfig: {},
    selectedValues: { endpoint: EModelEndpoint.agents, model: 'sovereign-model', modelSpec: '' },
    handleSelectModel,
    searchValue: '',
    searchResults: null,
    endpointSearchValues: {},
    assistantsMap: undefined,
    endpointRequiresUserKey: () => false,
    setSelectedValues: jest.fn(),
    setSearchValue: jest.fn(),
    setEndpointSearchValue: jest.fn(),
    handleSelectSpec: jest.fn(),
    handleSelectEndpoint: jest.fn(),
    keyDialogOpen: false,
    keyDialogEndpoint: null,
    onOpenChange: jest.fn(),
    handleOpenKeyDialog: jest.fn(),
  });
  render(<ModelSelector startupConfig={{ governancePilotEnabled: true } as TStartupConfig} />);
  await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));
  const agent = within(screen.getByRole('group', { name: 'My Agents' })).getByRole('option');
  expect(agent).toHaveAttribute('aria-selected', 'true');
  expect(
    within(screen.getByRole('group', { name: 'Models' })).getByRole('option'),
  ).not.toHaveAttribute('aria-selected', 'true');
  await userEvent.click(agent);
  expect(handleSelectModel).toHaveBeenLastCalledWith(agentEndpoint, 'sovereign-model');

  await userEvent.click(screen.getByRole('button', { name: 'Select a model' }));
  await userEvent.click(screen.getByRole('option', { name: 'sovereign-model' }));
  expect(handleSelectModel).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: GOVERNANCE_ENDPOINT }),
    'sovereign-model',
  );
});
