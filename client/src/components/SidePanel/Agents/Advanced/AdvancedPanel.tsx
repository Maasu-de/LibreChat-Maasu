import { useMemo } from 'react';
import { ChevronLeft } from 'lucide-react';
import { AgentCapabilities } from 'librechat-data-provider';
import { useFormContext, Controller } from 'react-hook-form';
import type { AgentForm } from '~/common';
import { useAgentPanelContext } from '~/Providers';
import { useGetStartupConfig } from '~/data-provider';
import AgentSubagents from './AgentSubagents';
import MaxAgentSteps from './MaxAgentSteps';
import AgentHandoffs from './AgentHandoffs';
import { useLocalize } from '~/hooks';
import AgentChain from './AgentChain';
import { Panel } from '~/common';

export default function AdvancedPanel() {
  const localize = useLocalize();
  const methods = useFormContext<AgentForm>();
  const { control, watch } = methods;
  const currentAgentId = watch('id');
  const { data: startupConfig } = useGetStartupConfig();
  const governancePilot = startupConfig?.governancePilotEnabled === true;

  const { agentsConfig, setActivePanel } = useAgentPanelContext();
  const chainEnabled = useMemo(
    () => agentsConfig?.capabilities.includes(AgentCapabilities.chain) ?? false,
    [agentsConfig],
  );
  const subagentsEnabled = useMemo(
    () => agentsConfig?.capabilities.includes(AgentCapabilities.subagents) ?? false,
    [agentsConfig],
  );

  return (
    <div className="mb-1 flex w-full min-w-0 flex-col gap-2 text-sm">
      <div className="advanced-panel mb-2 flex items-center gap-2 pt-2">
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
          onClick={() => {
            setActivePanel(Panel.builder);
          }}
          aria-label={localize('com_ui_back_to_builder')}
          title={localize('com_ui_back_to_builder')}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <h2 className="min-w-0 text-base font-semibold text-text-primary">
          {localize('com_ui_advanced_settings')}
        </h2>
      </div>
      <div className="flex min-w-0 flex-col gap-4 px-2 pb-2">
        <MaxAgentSteps />
        {subagentsEnabled && (
          <Controller
            name="subagents"
            control={control}
            render={({ field }) => <AgentSubagents field={field} currentAgentId={currentAgentId} />}
          />
        )}
        {!governancePilot && (
          <Controller
            name="edges"
            control={control}
            defaultValue={[]}
            render={({ field }) => <AgentHandoffs field={field} currentAgentId={currentAgentId} />}
          />
        )}
        {chainEnabled && (
          <Controller
            name="agent_ids"
            control={control}
            defaultValue={[]}
            render={({ field }) => <AgentChain field={field} currentAgentId={currentAgentId} />}
          />
        )}
      </div>
    </div>
  );
}
