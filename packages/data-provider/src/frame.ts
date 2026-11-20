import { apiBaseUrl, buildLoginRedirectUrl } from './api-endpoints';

interface FrameWindow {
  location: Pick<Location, 'origin' | 'pathname' | 'assign'>;
  document: Pick<Document, 'dispatchEvent'>;
  top: FrameWindow | null;
}

export function getMCPAdministrationHost(browser: FrameWindow = window): FrameWindow | null {
  if (browser.location.pathname !== `${apiBaseUrl()}/governance/mcp/content`) {
    return null;
  }
  try {
    const host = browser.top;
    return host && host !== browser && host.location.origin === browser.location.origin
      ? host
      : null;
  } catch {
    return null;
  }
}

export function redirectMCPFrameToLogin(browser: FrameWindow = window): boolean {
  const host = getMCPAdministrationHost(browser);
  if (!host) {
    return false;
  }
  host.location.assign(`${apiBaseUrl()}${buildLoginRedirectUrl('/governance/mcp', '', '')}`);
  return true;
}
