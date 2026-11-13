import 'test/matchMedia.mock';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('synchronizes the Gateway theme and forwards its sidebar shortcut in an embed', () => {
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
    localStorage.setItem('color-theme', 'system');
    localStorage.setItem('theme', 'dark');
    const { unmount } = render(<MCPConnections embedded />);
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('color-theme')).toBe('system');
    localStorage.setItem('theme', 'light');
    fireEvent(window, new StorageEvent('storage', { key: 'theme', newValue: 'light' }));
    expect(document.documentElement).toHaveClass('light');
    expect(localStorage.getItem('color-theme')).toBe('system');
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'b', ctrlKey: true }),
    );
    unmount();
    dispatchEvent.mockClear();
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(dispatchEvent).not.toHaveBeenCalled();
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
