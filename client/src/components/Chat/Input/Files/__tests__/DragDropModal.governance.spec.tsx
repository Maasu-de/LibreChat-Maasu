import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import { EModelEndpoint, EToolResources, GOVERNANCE_ENDPOINT } from 'librechat-data-provider';
import DragDropModal from '../DragDropModal';

let mockEndpoint: string = GOVERNANCE_ENDPOINT;

jest.mock('~/hooks', () => ({
  useAgentCapabilities: jest.requireActual('~/hooks/Agents/useAgentCapabilities').default,
  useGetAgentsConfig: () => ({ agentsConfig: { capabilities: [] } }),
  useAgentToolPermissions: () => ({
    provider: jest.requireActual('librechat-data-provider').GOVERNANCE_ENDPOINT,
    fileSearchAllowedByAgent: true,
    codeAllowedByAgent: true,
  }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { governancePilotEnabled: true } }),
}));

jest.mock('~/Providers', () => ({
  useDragDropContext: () => ({
    conversationId: 'conversation',
    endpoint: mockEndpoint,
    endpointType: jest.requireActual('librechat-data-provider').EModelEndpoint.custom,
  }),
}));

function renderOptions() {
  const onOptionSelect = jest.fn();
  render(
    <RecoilRoot>
      <DragDropModal
        onOptionSelect={onOptionSelect}
        files={[new File(['Agenda'], 'agenda.txt', { type: 'text/plain' })]}
        isVisible
        setShowModal={() => {}}
      />
    </RecoilRoot>,
  );
  return onOptionSelect;
}

it('offers only text context for classic governed file drops', () => {
  mockEndpoint = GOVERNANCE_ENDPOINT;
  const onOptionSelect = renderOptions();

  fireEvent.click(screen.getByRole('button', { name: 'com_ui_upload_ocr_text' }));

  expect(onOptionSelect).toHaveBeenCalledWith(EToolResources.context);
  expect(screen.queryByText('com_ui_upload_provider')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_upload_file_search')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_upload_code_environment')).not.toBeInTheDocument();
});

it('keeps saved governed agents without upload capabilities', () => {
  mockEndpoint = EModelEndpoint.agents;
  renderOptions();

  expect(screen.queryByText('com_ui_upload_ocr_text')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_upload_provider')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_upload_file_search')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_upload_code_environment')).not.toBeInTheDocument();
});
