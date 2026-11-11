import { useEffect } from 'react';
import { apiBaseUrl, SystemRoles, getMCPAdministrationHost } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { useGatewaySessionWatch } from '~/data-provider';
import MCPBuilderPanel from '~/components/SidePanel/MCPBuilder/MCPBuilderPanel';
import { MCPAdministrationContext } from '~/components/SidePanel/MCPBuilder/administration';
import useAuthRedirect from './useAuthRedirect';
import './MCPConnections.css';

export default function MCPConnections({ embedded = false }: { embedded?: boolean }) {
  const localize = useLocalize();
  const { isAuthenticated, user } = useAuthRedirect();
  useGatewaySessionWatch(isAuthenticated);

  useEffect(() => {
    if (!embedded) {
      return;
    }
    const host = getMCPAdministrationHost();
    if (!host) {
      if (isAuthenticated && window.top === window) {
        window.location.replace(`${apiBaseUrl()}/governance/mcp`);
      }
      return;
    }
    const root = document.documentElement;
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const synchronizeTheme = () => {
      const theme = localStorage.getItem('theme');
      const dark = theme === 'dark' || (theme !== 'light' && systemTheme.matches);
      if (root.classList.contains('dark') === dark && root.classList.contains('light') !== dark) {
        return;
      }
      root.classList.remove(dark ? 'light' : 'dark');
      root.classList.add(dark ? 'dark' : 'light');
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === 'theme') {
        synchronizeTheme();
      }
    };
    const forwardSidebarShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        host.document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            bubbles: true,
          }),
        );
      }
    };
    synchronizeTheme();
    const themeObserver = new MutationObserver(synchronizeTheme);
    themeObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
    systemTheme.addEventListener('change', synchronizeTheme);
    window.addEventListener('storage', handleStorage);
    document.addEventListener('keydown', forwardSidebarShortcut);
    return () => {
      themeObserver.disconnect();
      systemTheme.removeEventListener('change', synchronizeTheme);
      window.removeEventListener('storage', handleStorage);
      document.removeEventListener('keydown', forwardSidebarShortcut);
    };
  }, [embedded, isAuthenticated]);

  if (!isAuthenticated) {
    return null;
  }

  if (user?.role !== SystemRoles.GOVERNANCE_ADMIN) {
    return <p role="alert">{localize('com_ui_mcp_admin_required')}</p>;
  }

  return (
    <MCPAdministrationContext.Provider value={true}>
      <main
        aria-label={localize('com_ui_mcp_connections')}
        className={
          embedded
            ? 'mcp-connections h-full w-full overflow-y-auto text-text-primary'
            : 'mcp-connections mx-auto min-h-screen w-full max-w-5xl p-6 text-text-primary'
        }
      >
        {!embedded && (
          <h1 className="text-2xl font-semibold">{localize('com_ui_mcp_connections')}</h1>
        )}
        <p className="mcp-connections-description">
          {localize('com_ui_mcp_connections_description')}
        </p>
        <MCPBuilderPanel />
      </main>
    </MCPAdministrationContext.Provider>
  );
}
