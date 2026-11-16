import { ChevronDown } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import { useInspectMCPServerMutation } from '~/data-provider/MCP';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default function MCPInspection({ serverName }: { serverName: string }) {
  const localize = useLocalize();
  const inspection = useInspectMCPServerMutation();
  const expanded = inspection.isSuccess || inspection.isError;

  return (
    <div className="mcp-inspection space-y-3 border-x border-b border-border-light p-3">
      <Button
        variant="outline"
        onClick={() => (expanded ? inspection.reset() : inspection.mutate(serverName))}
        aria-expanded={expanded}
        disabled={inspection.isLoading}
      >
        {inspection.isLoading && <Spinner className="mr-2 size-4" />}
        {localize(expanded ? 'com_ui_mcp_inspection_hide' : 'com_ui_mcp_inspect')}
        <ChevronDown
          className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </Button>
      {(inspection.isError || inspection.data?.success === false) && (
        <p role="alert">{localize('com_ui_mcp_server_connection_failed')}</p>
      )}
      {inspection.data?.success && (
        <div role="status" className="space-y-3">
          <p>{localize('com_ui_mcp_inspection_success')}</p>
          {inspection.data.tools.length === 0 && <p>{localize('com_ui_mcp_no_tools')}</p>}
          {inspection.data.tools.map((tool) => (
            <details key={tool.name} className="rounded border border-border-light p-3">
              <summary className="cursor-pointer font-medium">{tool.name}</summary>
              {tool.description && <p className="my-2 text-sm">{tool.description}</p>}
              <pre className="overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(tool.inputSchema, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
