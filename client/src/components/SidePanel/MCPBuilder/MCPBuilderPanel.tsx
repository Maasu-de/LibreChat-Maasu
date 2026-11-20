import { useState, useRef, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  Button,
  Input,
  Spinner,
  FilterInput,
  OGDialogTrigger,
  TooltipAnchor,
} from '@librechat/client';
import { useLocalize, useMCPServerManager, useHasAccess } from '~/hooks';
import MCPConfigDialog from '~/components/MCP/MCPConfigDialog';
import MCPAdminSettings from './MCPAdminSettings';
import { useMCPAdministration } from './administration';
import MCPServerDialog from './MCPServerDialog';
import MCPServerList from './MCPServerList';

export default function MCPBuilderPanel() {
  const localize = useLocalize();
  const administration = useMCPAdministration();
  const {
    availableMCPServers,
    isLoading,
    isError,
    getServerStatusIconProps,
    getConfigDialogProps,
  } = useMCPServerManager();

  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.CREATE,
  });
  const [showDialog, setShowDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const configDialogProps = getConfigDialogProps();

  const filteredServers = useMemo(() => {
    if (!searchQuery.trim()) {
      return availableMCPServers;
    }
    const query = searchQuery.toLowerCase();
    return availableMCPServers.filter((server) => {
      const displayName = server.config?.title || server.serverName;
      return (
        displayName.toLowerCase().includes(query) || server.serverName.toLowerCase().includes(query)
      );
    });
  }, [availableMCPServers, searchQuery]);

  return (
    <div className={administration ? 'w-full' : 'flex h-auto w-full flex-col px-3 pb-3 pt-2'}>
      <div
        role="region"
        aria-label={localize('com_ui_mcp_servers')}
        className={administration ? 'space-y-6' : 'space-y-2'}
      >
        {/* Toolbar: Search + Add Button */}
        <div
          className={
            administration ? 'flex flex-wrap items-center gap-3' : 'flex items-center gap-2'
          }
        >
          {administration ? (
            <Input
              id="mcp-filter"
              aria-label={localize('com_ui_filter_mcp_servers')}
              placeholder={localize('com_ui_filter_mcp_servers')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="mcp-connections-filter min-w-48 flex-1"
            />
          ) : (
            <FilterInput
              inputId="mcp-filter"
              label={localize('com_ui_filter_mcp_servers')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              containerClassName="flex-1"
            />
          )}
          {hasCreateAccess && (
            <MCPServerDialog
              open={showDialog}
              onOpenChange={setShowDialog}
              triggerRef={addButtonRef}
            >
              <OGDialogTrigger asChild>
                <TooltipAnchor
                  description={localize('com_ui_add_mcp')}
                  side="bottom"
                  render={
                    <Button
                      ref={addButtonRef}
                      variant={administration ? 'default' : 'outline'}
                      size={administration ? 'default' : 'icon'}
                      className={
                        administration
                          ? 'mcp-connections-add shrink-0'
                          : 'size-9 shrink-0 bg-transparent'
                      }
                      onClick={() => setShowDialog(true)}
                      aria-label={localize(
                        administration ? 'com_ui_add_mcp_server' : 'com_ui_add_mcp',
                      )}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      {administration && localize('com_ui_add_mcp_server')}
                    </Button>
                  }
                />
              </OGDialogTrigger>
            </MCPServerDialog>
          )}
        </div>

        {/* Server Cards List */}
        {administration && isError && <p role="alert">{localize('com_ui_error')}</p>}
        {!(administration && isError) &&
          (isLoading ? (
            <div className="flex items-center justify-center p-8">
              <Spinner className="size-6" aria-label={localize('com_ui_loading')} />
            </div>
          ) : (
            <MCPServerList
              servers={filteredServers}
              getServerStatusIconProps={getServerStatusIconProps}
              isFiltered={searchQuery.trim().length > 0}
            />
          ))}

        {/* Config Dialog for custom user vars */}
        {!administration && configDialogProps && <MCPConfigDialog {...configDialogProps} />}

        {/* Admin Settings Section */}
        {!administration && <MCPAdminSettings />}
      </div>
    </div>
  );
}
