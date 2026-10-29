import { useState } from 'react';
import { TooltipAnchor } from '@librechat/client';
import { CheckCircle2, Info } from 'lucide-react';
import { useGetGovernanceModelsQuery } from 'librechat-data-provider/react-query';
import type { ReactElement } from 'react';
import { CustomMenu as Menu, CustomMenuItem as MenuItem } from './CustomMenu';
import { groupGovernanceModels } from './governance';
import { useLocalize } from '~/hooks';

export default function GovernanceModelSelector({
  endpoint,
  value,
  onSelect,
  trigger,
}: {
  endpoint: string;
  value: string | null;
  onSelect: (model: string) => void;
  trigger?: ReactElement;
}) {
  const localize = useLocalize();
  const { data, isLoading, isFetching, isError, refetch } = useGetGovernanceModelsQuery();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const groups = groupGovernanceModels(data?.[endpoint] ?? []);
  return (
    <Menu
      trigger={trigger}
      label={trigger ? undefined : value || localize('com_ui_select_model')}
      aria-label={localize('com_ui_select_model')}
      searchValue={search}
      onSearch={setSearch}
      combobox={<input placeholder=" " />}
      comboboxLabel={localize('com_endpoint_search_models')}
    >
      {(isLoading || isError || groups.length === 0) && (
        <div className="px-3 py-2 text-sm text-text-secondary">
          <p role="status">
            {localize(isFetching ? 'com_ui_loading' : 'com_ui_governance_models_unavailable')}
          </p>
          {!isLoading && (
            <button
              type="button"
              className="mt-1 rounded px-2 py-1 text-text-primary hover:bg-surface-hover disabled:opacity-50"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {localize('com_ui_retry')}
            </button>
          )}
        </div>
      )}
      {groups.map(({ tier, models }) => {
        const matchingModels = models.filter((model) =>
          `${model.id} ${tier?.code ?? ''} ${tier?.name ?? ''}`.toLowerCase().includes(query),
        );
        if (!matchingModels.length) {
          return null;
        }
        const title = tier?.name ?? localize('com_ui_governance_tier_unavailable');
        const description =
          tier?.description ?? localize('com_ui_governance_tier_unavailable_description');
        return (
          <div
            key={tier?.code ?? 'unavailable'}
            role="group"
            aria-label={title}
            className="mt-2 border-t border-border-light first:mt-0 first:border-t-0"
          >
            <TooltipAnchor
              description={description}
              side="right"
              className="cursor-help"
              render={
                <h3
                  tabIndex={0}
                  className="flex items-center justify-between rounded-md bg-surface-secondary px-3 py-2 text-sm font-semibold text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span>{title}</span>
                  <Info className="size-3.5" aria-hidden="true" />
                </h3>
              }
            />
            {matchingModels.map((model) => (
              <MenuItem
                key={model.id}
                onClick={() => onSelect(model.id)}
                aria-selected={value === model.id || undefined}
                className="flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm"
              >
                <span>{model.id}</span>
                {value === model.id && <CheckCircle2 className="size-4" aria-hidden="true" />}
              </MenuItem>
            ))}
          </div>
        );
      })}
    </Menu>
  );
}
