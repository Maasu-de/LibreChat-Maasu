import { getMCPAdministrationHost, redirectMCPFrameToLogin } from './frame';

jest.mock('./api-endpoints', () => ({
  ...jest.requireActual('./api-endpoints'),
  apiBaseUrl: () => '/chat',
}));

function createFrame() {
  const host = {
    location: {
      origin: 'https://governance.example',
      pathname: '/chat/governance/mcp',
      assign: jest.fn(),
    },
    document: { dispatchEvent: jest.fn() },
    top: null,
  };
  const frame = {
    location: {
      origin: 'https://governance.example',
      pathname: '/chat/governance/mcp/content',
      assign: jest.fn(),
    },
    document: { dispatchEvent: jest.fn() },
    top: host,
  };
  return { host, frame };
}

describe('embedded MCP authentication', () => {
  it('uses top-level login with the admin shell as the return target', () => {
    const { host, frame } = createFrame();
    expect(redirectMCPFrameToLogin(frame)).toBe(true);
    expect(host.location.assign).toHaveBeenCalledWith(
      '/chat/login?redirect_to=%2Fgovernance%2Fmcp',
    );
    expect(frame.location.assign).not.toHaveBeenCalled();
  });

  it('keeps ordinary chat and standalone navigation unchanged', () => {
    const { host, frame } = createFrame();
    frame.location.pathname = '/chat/c/new';
    expect(redirectMCPFrameToLogin(frame)).toBe(false);
    frame.location.pathname = '/chat/governance/mcp';
    expect(redirectMCPFrameToLogin(frame)).toBe(false);
    expect(host.location.assign).not.toHaveBeenCalled();
  });

  it('does not bridge a cross-origin frame', () => {
    const { host, frame } = createFrame();
    host.location.origin = 'https://another.example';
    expect(getMCPAdministrationHost(frame)).toBeNull();
    expect(redirectMCPFrameToLogin(frame)).toBe(false);
    expect(host.location.assign).not.toHaveBeenCalled();
  });

  it('handles cross-origin access restrictions without affecting ordinary auth', () => {
    const { host, frame } = createFrame();
    Object.defineProperty(host.location, 'origin', {
      get: () => {
        throw new Error('SecurityError');
      },
    });
    expect(redirectMCPFrameToLogin(frame)).toBe(false);
  });
});
