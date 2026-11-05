import { useMemo } from 'react';
import { X } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import { isAgentsEndpoint, GOVERNANCE_ENDPOINT } from 'librechat-data-provider';
import GovernanceModelSelector from '~/components/Chat/Menus/Endpoints/GovernanceModelSelector';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useAgentsMapContext, useAddedChatContext } from '~/Providers';
import { EndpointIcon } from '~/components/Endpoints';
import { useLocalize } from '~/hooks';

const boxClassName =
  'my-1 flex h-9 max-w-[40vw] items-center justify-center gap-2 rounded-xl border border-border-light bg-presentation px-3 py-2 text-sm text-text-primary hover:bg-surface-active-alt';

/** The second model of a comparison, shown next to the model selector once the plus is clicked. */
export default function AddedConvo() {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: startupConfig } = useGetStartupConfig();
  const { conversation: addedConvo, setConversation: setAddedConvo } = useAddedChatContext();
  const title = useMemo(() => {
    if (isAgentsEndpoint(addedConvo?.endpoint) && addedConvo?.agent_id) {
      const agent = agentsMap?.[addedConvo.agent_id];
      if (agent?.name) {
        return agent.name;
      }
    }
    const endpointConfig = endpointsConfig?.[addedConvo?.endpoint ?? ''];
    return addedConvo?.model || endpointConfig?.modelDisplayLabel || addedConvo?.modelLabel || 'AI';
  }, [addedConvo, agentsMap, endpointsConfig]);

  if (!addedConvo) {
    return null;
  }

  const box = (
    <button type="button" className={boxClassName} aria-label={localize('com_ui_compare_with')}>
      <span className="flex flex-shrink-0 items-center justify-center overflow-hidden">
        <EndpointIcon
          conversation={addedConvo}
          endpointsConfig={endpointsConfig}
          agentsMap={agentsMap}
          containerClassName="shadow-stroke overflow-hidden rounded-full"
          context="menu-item"
          size={20}
        />
      </span>
      <span className="flex-grow truncate text-left">{title}</span>
    </button>
  );

  return (
    <div className="flex items-center gap-2">
      <span className="whitespace-nowrap text-xs font-normal text-text-secondary">
        {localize('com_ui_compare_with')}
      </span>
      {startupConfig?.governancePilotEnabled && addedConvo.endpoint === GOVERNANCE_ENDPOINT ? (
        <GovernanceModelSelector
          endpoint={GOVERNANCE_ENDPOINT}
          value={addedConvo.model ?? null}
          trigger={box}
          onSelect={(model) =>
            setAddedConvo((previous) => (previous ? { ...previous, model } : previous))
          }
        />
      ) : (
        box
      )}
      <TooltipAnchor
        description={localize('com_ui_remove_comparison')}
        aria-label={localize('com_ui_remove_comparison')}
        render={
          <button
            type="button"
            onClick={() => setAddedConvo(null)}
            className="inline-flex size-9 flex-shrink-0 items-center justify-center rounded-xl border border-border-light bg-presentation text-text-primary hover:bg-surface-tertiary"
          >
            <X className="icon-sm" aria-hidden="true" />
          </button>
        }
      />
    </div>
  );
}
