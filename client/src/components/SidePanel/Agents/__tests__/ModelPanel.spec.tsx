import React from 'react';
import { RecoilRoot } from 'recoil';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  EModelEndpoint,
  GOVERNANCE_ENDPOINT,
  GOVERNANCE_AGENT_MODEL_PARAMETERS,
} from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { ChatContext } from '~/Providers/ChatContext';
import { useLocalize } from '~/hooks';
import ModelPanel from '../ModelPanel';

let mockGovernancePilot = true;
const mockEndpoints = {
  [GOVERNANCE_ENDPOINT]: { type: EModelEndpoint.custom, userProvide: false },
};

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpoints }),
  useGetStartupConfig: () => ({
    data: { governancePilotEnabled: mockGovernancePilot },
  }),
}));

const chatContext = { preset: null } as NonNullable<
  React.ComponentProps<typeof ChatContext.Provider>['value']
>;

const models = [
  'logical-model',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemma-4-26b-a4b-it-maas',
];

type ModelParameters = Partial<AgentForm['model_parameters']> & { max_tokens?: number };

function ModelForm({
  onSave,
  model = 'logical-model',
  modelParameters = {},
}: {
  onSave: (agent: AgentForm) => void;
  model?: string;
  modelParameters?: ModelParameters;
}) {
  const localize = useLocalize();
  const methods = useForm<AgentForm>({
    defaultValues: {
      provider: GOVERNANCE_ENDPOINT,
      model,
      model_parameters: modelParameters,
    },
  });
  const parameters = useWatch({
    control: methods.control,
    name: 'model_parameters',
  });

  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSave)}>
        <ModelPanel
          providers={[{ value: GOVERNANCE_ENDPOINT, label: GOVERNANCE_ENDPOINT }]}
          models={{ [GOVERNANCE_ENDPOINT]: models }}
          setActivePanel={() => {}}
        />
        <output data-testid="parameters">{JSON.stringify(parameters)}</output>
        <button type="button" onClick={() => methods.setValue('model', 'gemini-3.6-flash')}>
          Switch to Gemini 3.6
        </button>
        <button type="submit">{localize('com_ui_save')}</button>
      </form>
    </FormProvider>
  );
}

function renderPanel(
  onSave: (agent: AgentForm) => void = () => {},
  model = 'logical-model',
  modelParameters: ModelParameters = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RecoilRoot>
        <ChatContext.Provider value={chatContext}>
          <ModelForm onSave={onSave} model={model} modelParameters={modelParameters} />
        </ChatContext.Provider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockGovernancePilot = true;
});

it.each<[string, readonly string[]]>([
  ['gemini-2.5-flash', [...GOVERNANCE_AGENT_MODEL_PARAMETERS]],
  ['gemma-4-26b-a4b-it-maas', [...GOVERNANCE_AGENT_MODEL_PARAMETERS]],
  ...[
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
  ].map((model): [string, string[]] => [
    model,
    ['maxContextTokens', 'max_tokens', 'temperature', 'top_p'],
  ]),
  ['gemini-3.6-flash', ['maxContextTokens', 'max_tokens']],
])('shows the supported parameters for %s', (model, expected) => {
  const { container } = renderPanel(undefined, model);
  const controls = container.querySelectorAll(
    '[id$="-dynamic-input"], [id$="-dynamic-setting-slider"]',
  );
  expect(
    Array.from(controls, (control) => control.id.replace(/-dynamic-(?:input|setting-slider)$/, '')),
  ).toEqual(expected);
});

it('removes incompatible saved values when switching models and preserves token limits', async () => {
  const onSave = jest.fn();
  renderPanel(onSave, 'gemini-2.5-flash', {
    maxContextTokens: 8192,
    max_tokens: 256,
    temperature: 0.4,
    top_p: 0.8,
    frequency_penalty: 0.2,
    presence_penalty: 0.3,
  });

  fireEvent.click(screen.getByRole('button', { name: 'Switch to Gemini 3.6' }));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

  await waitFor(() => {
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.6-flash',
        model_parameters: { maxContextTokens: 8192, max_tokens: 256 },
      }),
      expect.anything(),
    );
  });
  expect(screen.queryByText('Temperature', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText('Top P', { exact: true })).not.toBeInTheDocument();
});

it('clears incompatible values when opening an existing agent', async () => {
  const onSave = jest.fn();
  renderPanel(onSave, 'gemini-3.5-flash', { temperature: 0.4, frequency_penalty: 0.2 });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

  await waitFor(() => {
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ model_parameters: { temperature: 0.4 } }),
      expect.anything(),
    );
  });
});

it('shows only the parameters supported by governed agents', () => {
  const { container } = renderPanel();
  const controls = container.querySelectorAll(
    '[id$="-dynamic-input"], [id$="-dynamic-setting-slider"]',
  );
  const keys = Array.from(controls, (control) =>
    control.id.replace(/-dynamic-(?:input|setting-slider)$/, ''),
  );

  expect(keys).toEqual([...GOVERNANCE_AGENT_MODEL_PARAMETERS]);
  for (const label of ['Reasoning Effort', 'Reasoning Summary', 'Verbosity', 'Use Responses API']) {
    expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
  }
});

it('saves edits from every visible governed model parameter', async () => {
  const onSave = jest.fn();
  renderPanel(onSave);
  const parameters = {
    maxContextTokens: 8192,
    max_tokens: 256,
    temperature: 0.4,
    top_p: 0.8,
    frequency_penalty: 0.2,
    presence_penalty: 0.3,
  };

  for (const [key, value] of Object.entries(parameters)) {
    const input =
      document.getElementById(`${key}-dynamic-input`) ??
      document.getElementById(`${key}-dynamic-setting-input-number`);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`Missing model parameter input: ${key}`);
    }
    fireEvent.change(input, { target: { value: String(value) } });
  }

  await waitFor(() => {
    expect(JSON.parse(screen.getByTestId('parameters').textContent ?? '{}')).toEqual(parameters);
  });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => {
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ model_parameters: parameters }),
      expect.anything(),
    );
  });
});

it('retains the standalone model parameter controls', () => {
  mockGovernancePilot = false;
  renderPanel(undefined, 'gemini-3.6-flash');

  for (const label of [
    'Temperature',
    'Frequency Penalty',
    'Reasoning Effort',
    'Reasoning Summary',
    'Verbosity',
    'Use Responses API',
  ]) {
    expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
  }
});
