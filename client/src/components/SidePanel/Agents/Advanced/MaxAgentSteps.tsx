import { useFormContext, Controller } from 'react-hook-form';
import {
  HoverCard,
  FormInput,
  HoverCardPortal,
  HoverCardContent,
  HoverCardTrigger,
  CircleHelpIcon,
} from '@librechat/client';
import type { AgentForm } from '~/common';
import { useLocalize } from '~/hooks';
import { ESide } from '~/common';

export default function AdvancedPanel() {
  const localize = useLocalize();
  const methods = useFormContext<AgentForm>();
  const { control } = methods;

  return (
    <HoverCard openDelay={50}>
      <Controller
        name="recursion_limit"
        control={control}
        render={({ field }) => (
          <FormInput
            field={field}
            containerClass="min-w-0"
            inputClass="w-full"
            label={localize('com_ui_agent_recursion_limit')}
            placeholder={localize('com_nav_theme_system')}
            type="number"
            labelClass="min-w-0 leading-5"
            labelAdjacent={
              <HoverCardTrigger className="inline-flex shrink-0 items-center justify-center">
                <CircleHelpIcon className="h-4 w-4 text-text-tertiary" />
              </HoverCardTrigger>
            }
          />
        )}
      />
      <HoverCardPortal>
        <HoverCardContent side={ESide.Top} className="w-80">
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">
              {localize('com_ui_agent_recursion_limit_info')}
            </p>
          </div>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}
