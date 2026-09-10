import { useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Cpu, DollarSign, RefreshCcw, Users } from 'lucide-react';
import { hasFinancesRole } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { FinanceUsageBreakdownRow } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';
import { useGovernanceUsageQuery } from '~/data-provider';
import { cn } from '~/utils';

const dateInputValue = (date: Date) => date.toISOString().slice(0, 10);

const defaultStartDate = () => {
  const date = new Date();
  date.setDate(date.getDate() - 29);
  return dateInputValue(date);
};

const formatInteger = (value: number) => new Intl.NumberFormat().format(value);

const formatCurrency = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1 ? 6 : 2,
  }).format(value);

function Metric({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-light bg-surface-primary p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-text-secondary">{label}</span>
        <span className={cn('rounded-md p-2', tone)}>{icon}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function BreakdownTable({
  title,
  emptyLabel,
  rows,
}: {
  title: string;
  emptyLabel: string;
  rows: FinanceUsageBreakdownRow[];
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border-light bg-surface-primary shadow-sm">
      <div className="border-b border-border-light px-4 py-3">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-sm text-text-secondary">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-surface-secondary text-xs uppercase text-text-secondary">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 text-right font-medium">Requests</th>
                <th className="px-4 py-3 text-right font-medium">Input</th>
                <th className="px-4 py-3 text-right font-medium">Output</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-light">
              {rows.map((row) => (
                <tr key={row.key} className="text-text-primary">
                  <td className="max-w-[240px] truncate px-4 py-3">{row.label}</td>
                  <td className="px-4 py-3 text-right">{formatInteger(row.request_count)}</td>
                  <td className="px-4 py-3 text-right">{formatInteger(row.input_tokens)}</td>
                  <td className="px-4 py-3 text-right">{formatInteger(row.output_tokens)}</td>
                  <td className="px-4 py-3 text-right">{formatInteger(row.total_tokens)}</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(row.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function FinanceDashboard() {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuthContext();
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(() => dateInputValue(new Date()));
  const hasAccess = hasFinancesRole(user?.role);

  const params = useMemo(
    () => ({
      start_date: startDate,
      end_date: endDate,
    }),
    [startDate, endDate],
  );

  const usageQuery = useGovernanceUsageQuery(params, {
    enabled: isAuthenticated && hasAccess,
  });

  if (!isAuthenticated) {
    return null;
  }

  if (!hasAccess) {
    return <Navigate to="/c/new" replace={true} />;
  }

  const usage = usageQuery.data;
  const totals = usage?.totals;

  return (
    <main className="h-full overflow-y-auto bg-surface-primary-alt">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 md:px-6 lg:px-8">
        <div className="flex flex-col gap-4 border-b border-border-light pb-5 md:flex-row md:items-end md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              onClick={() => navigate('/c/new')}
              aria-label="Back to chat"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-text-primary">Cost and usage</h1>
              <div className="mt-1 flex items-center gap-2 text-sm text-text-secondary">
                <CalendarDays className="h-4 w-4" aria-hidden="true" />
                <span>
                  {usage?.range.start_date ?? startDate} to {usage?.range.end_date ?? endDate}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              <span>Start</span>
              <input
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="h-10 rounded-lg border border-border-light bg-surface-primary px-3 text-text-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              <span>End</span>
              <input
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="h-10 rounded-lg border border-border-light bg-surface-primary px-3 text-text-primary"
              />
            </label>
            <button
              type="button"
              onClick={() => usageQuery.refetch()}
              className="flex h-10 items-center gap-2 rounded-lg bg-surface-tertiary px-3 text-sm font-medium text-text-primary hover:bg-surface-hover"
            >
              <RefreshCcw className="h-4 w-4" aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>

        {usageQuery.isError ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-text-primary">
            Could not load cost and usage data.
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Estimated cost"
            value={formatCurrency(totals?.cost_usd ?? 0)}
            tone="bg-green-500/10 text-green-700 dark:text-green-300"
            icon={<DollarSign className="h-5 w-5" aria-hidden="true" />}
          />
          <Metric
            label="Total tokens"
            value={formatInteger(totals?.total_tokens ?? 0)}
            tone="bg-blue-500/10 text-blue-700 dark:text-blue-300"
            icon={<Cpu className="h-5 w-5" aria-hidden="true" />}
          />
          <Metric
            label="Input tokens"
            value={formatInteger(totals?.input_tokens ?? 0)}
            tone="bg-amber-500/10 text-amber-700 dark:text-amber-300"
            icon={<Cpu className="h-5 w-5" aria-hidden="true" />}
          />
          <Metric
            label="Requests"
            value={formatInteger(totals?.request_count ?? 0)}
            tone="bg-sky-500/10 text-sky-700 dark:text-sky-300"
            icon={<Users className="h-5 w-5" aria-hidden="true" />}
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <BreakdownTable
            title="Usage by user"
            emptyLabel={usageQuery.isLoading ? 'Loading usage...' : 'No user usage found.'}
            rows={usage?.by_user ?? []}
          />
          <BreakdownTable
            title="Usage by model"
            emptyLabel={usageQuery.isLoading ? 'Loading usage...' : 'No model usage found.'}
            rows={usage?.by_model ?? []}
          />
        </div>

        <BreakdownTable
          title="Usage by team"
          emptyLabel={usageQuery.isLoading ? 'Loading usage...' : 'No team usage found.'}
          rows={usage?.by_team ?? []}
        />
      </div>
    </main>
  );
}
