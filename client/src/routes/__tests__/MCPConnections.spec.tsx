import 'test/matchMedia.mock';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@librechat/client';
import { getMCPAdministrationHost, SystemRoles } from 'librechat-data-provider';
import MCPConnections from '../MCPConnections';

let mockRole: string = SystemRoles.GOVERNANCE_ADMIN;
let mockAuthenticated = true;
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  getMCPAdministrationHost: jest.fn(() => null),
}));

jest.mock('../useAuthRedirect', () => ({
  __esModule: true,
  default: () => ({ isAuthenticated: mockAuthenticated, user: { role: mockRole } }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({ useGatewaySessionWatch: jest.fn() }));

jest.mock('~/components/SidePanel/MCPBuilder/MCPBuilderPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="mcp-management" />,
}));

describe('standalone MCP administration', () => {
  beforeEach(() => {
    mockAuthenticated = true;
    localStorage.clear();
    jest.mocked(getMCPAdministrationHost).mockReturnValue(null);
    mockRole = SystemRoles.GOVERNANCE_ADMIN;
  });

  afterEach(() => {
    document.cookie = 'aimo-theme=; Path=/; Max-Age=0';
  });

  it('shows management in a standalone view for the OIDC governance role', () => {
    render(<MCPConnections />);
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('mcp-management'));
    expect(screen.getByRole('heading')).toHaveTextContent('com_ui_mcp_connections');
  });

  it('fits the Gateway shell without duplicating its heading', () => {
    jest.mocked(getMCPAdministrationHost).mockReturnValue({
      location: {
        origin: window.location.origin,
        pathname: '/chat/governance/mcp',
        assign: jest.fn(),
      },
      document: { dispatchEvent: jest.fn() },
      top: null,
    });
    render(<MCPConnections embedded />);
    expect(screen.getByTestId('mcp-management')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveClass('min-h-screen');
  });

  it('forwards the Gateway sidebar shortcut in an embed', () => {
    const dispatchEvent = jest.fn();
    jest.mocked(getMCPAdministrationHost).mockReturnValue({
      location: {
        origin: window.location.origin,
        pathname: '/chat/governance/mcp',
        assign: jest.fn(),
      },
      document: { dispatchEvent },
      top: null,
    });
    const { unmount } = render(<MCPConnections embedded />);
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'b', ctrlKey: true }),
    );
    unmount();
    dispatchEvent.mockClear();
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('keeps the embedded manager on the shared cookie theme despite obsolete storage', async () => {
    jest.mocked(getMCPAdministrationHost).mockReturnValue({
      location: {
        origin: window.location.origin,
        pathname: '/chat/governance/mcp',
        assign: jest.fn(),
      },
      document: { dispatchEvent: jest.fn() },
      top: null,
    });
    document.cookie = 'aimo-theme=dark; Path=/';
    localStorage.setItem('theme', 'light');
    await act(async () => {
      render(
        <ThemeProvider>
          <MCPConnections embedded />
        </ThemeProvider>,
      );
    });
    const manager = screen.getByTestId('mcp-management');
    expect(document.documentElement).toHaveClass('dark');

    await act(async () => {
      document.cookie = 'aimo-theme=light; Path=/';
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.documentElement).toHaveClass('light');

    await act(async () => {
      document.cookie = 'aimo-theme=dark; Path=/';
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(document.documentElement).toHaveClass('dark');

    await act(async () => {
      localStorage.setItem('theme', 'dark');
      document.cookie = 'aimo-theme=; Path=/; Max-Age=0';
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(document.documentElement).toHaveClass('light');
    expect(screen.getByTestId('mcp-management')).toBe(manager);
  });

  it.each([SystemRoles.USER, SystemRoles.ADMIN])('denies the %s role', (role) => {
    mockRole = role;
    render(<MCPConnections />);
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_mcp_admin_required');
    expect(screen.queryByTestId('mcp-management')).not.toBeInTheDocument();
  });

  it('waits for the authenticated LibreChat session', () => {
    mockAuthenticated = false;
    render(<MCPConnections />);
    expect(screen.queryByTestId('mcp-management')).not.toBeInTheDocument();
  });
});
