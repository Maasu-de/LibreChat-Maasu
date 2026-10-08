import { cloneElement } from 'react';
import { render, screen } from '@testing-library/react';
import { Artifact } from '../Artifact';

let mockShared = true;
let mockConfig: { governancePilotEnabled: boolean } | undefined;
const mockSetArtifacts = jest.fn();
const mockResetCounter = jest.fn();

jest.mock('recoil', () => ({ useSetRecoilState: () => mockSetArtifacts }));
jest.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/share/test' }) }));
jest.mock('~/store/artifacts', () => ({ artifactsState: {} }));
jest.mock('~/Providers', () => ({
  useShareContext: () => ({ isSharedConvo: mockShared, shareId: mockShared ? 'test' : undefined }),
  useMessageContext: () => ({ messageId: 'message' }),
  useArtifactContext: () => ({ getNextIndex: () => 0, resetCounter: mockResetCounter }),
}));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { governancePilotEnabled: false } }),
  useGetSharedStartupConfig: () => ({ data: mockConfig }),
}));
jest.mock('~/utils', () => ({
  extractContent: (content: string) => content,
  isArtifactRoute: () => true,
  logger: { log: jest.fn() },
}));
jest.mock('../ArtifactButton', () => () => <button />);

beforeEach(() => {
  mockShared = true;
  mockConfig = { governancePilotEnabled: true };
});

const artifact = (
  <Artifact
    id="example"
    lastUpdateTime={0}
    node={null}
    title="Example"
    type="text/html"
    identifier="example"
  >
    {'<p>Shared content</p>'}
  </Artifact>
);

it('renders governed shared artifacts as text without registering a preview', () => {
  render(artifact);
  expect(screen.getByText('<p>Shared content</p>').tagName).toBe('PRE');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(mockSetArtifacts).not.toHaveBeenCalled();
});

it('waits for shared config before registering artifacts', () => {
  mockConfig = undefined;
  const { rerender } = render(artifact);
  expect(mockSetArtifacts).not.toHaveBeenCalled();
  mockConfig = { governancePilotEnabled: false };
  rerender(cloneElement(artifact));
  expect(screen.getByRole('button')).toBeInTheDocument();
  expect(mockSetArtifacts).toHaveBeenCalled();
});

it('uses authenticated config outside shared conversations', () => {
  mockShared = false;
  render(artifact);
  expect(screen.getByRole('button')).toBeInTheDocument();
  expect(mockSetArtifacts).toHaveBeenCalled();
});
