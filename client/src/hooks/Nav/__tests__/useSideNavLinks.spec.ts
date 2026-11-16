import { renderHook } from '@testing-library/react';
import useSideNavLinks from '../useSideNavLinks';

jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useMCPServerManager: () => ({ availableMCPServers: [] }),
  useGetAgentsConfig: () => ({ agentsConfig: {} }),
  useAgentCapabilities: () => ({ skillsEnabled: false }),
}));
jest.mock('~/components/SidePanel/MCPBuilder/MCPBuilderPanel', () => () => null);
jest.mock('~/components/SidePanel/Agents/AgentPanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Bookmarks/BookmarkPanel', () => () => null);
jest.mock('~/components/SidePanel/Builder/PanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Parameters/Panel', () => () => null);
jest.mock('~/components/SidePanel/Memories', () => ({ MemoryPanel: () => null }));
jest.mock('~/components/SidePanel/Files/Panel', () => () => null);
jest.mock('~/components/Prompts', () => ({ PromptsAccordion: () => null }));
jest.mock('~/components/Skills', () => ({ SkillsAccordion: () => null }));

it.each([false, undefined])('respects the existing MCP chat interface setting %s', (use) => {
  const { result } = renderHook(() =>
    useSideNavLinks({
      keyProvided: false,
      interfaceConfig: { mcpServers: { use } },
      endpointsConfig: {},
    }),
  );
  expect(result.current.some((link) => link.id === 'mcp-builder')).toBe(use !== false);
});
