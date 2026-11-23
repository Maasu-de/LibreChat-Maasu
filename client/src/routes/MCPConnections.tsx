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
    document.addEventListener('keydown', forwardSidebarShortcut);
    return () => {
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
        <div className={embedded ? 'mcp-connections-content' : undefined}>
          <p className="mcp-connections-description">
            {localize('com_ui_mcp_connections_description')}
          </p>
          <MCPBuilderPanel />
        </div>
      </main>
    </MCPAdministrationContext.Provider>
  );
}
