import type { FinanceUsageBreakdownRow, FinanceUsageDashboard } from 'librechat-data-provider';
import type { GovernanceUsageDeps } from './governance';
import { resolveUsageLabels } from './governance';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '665f1c2e9b1e8a0012345678';
/** Computed with the gateway's `pseudonymize_user_id` using secret `test-secret` */
const USER_PSEUDONYM = 'sha256:d84316cbca2fb4d87987de855829f6c3c124b9d7a7ab0fcdba3b1d6a78b4017f';
const UNKNOWN_PSEUDONYM = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

const row = (key: string): FinanceUsageBreakdownRow => ({
  key,
  label: key,
  request_count: 1,
  input_tokens: 1,
  output_tokens: 1,
  total_tokens: 2,
  cost_usd: '0.01',
});

const dashboard = (overrides: Partial<FinanceUsageDashboard> = {}): FinanceUsageDashboard => ({
  range: { start_date: '2026-09-01', end_date: '2026-09-18' },
  totals: {
    request_count: 2,
    input_tokens: 2,
    output_tokens: 2,
    total_tokens: 4,
    cost_usd: '0.02',
  },
  by_user: [row(USER_PSEUDONYM), row(UNKNOWN_PSEUDONYM)],
  by_team: [row('665f1c2e9b1e8a0087654321'), row('entra-group-1'), row('missing-group')],
  by_model: [row('gemini-3.6-flash')],
  ...overrides,
});

const createDeps = (): jest.Mocked<GovernanceUsageDeps> => ({
  findUsers: jest
    .fn()
    .mockResolvedValue([
      { _id: USER_ID, name: 'Nikola Test', username: 'nikola', email: 'nikola@example.com' },
    ]),
  findGroups: jest.fn().mockResolvedValue([
    { _id: '665f1c2e9b1e8a0087654321', name: 'Finance' },
    { _id: '665f1c2e9b1e8a00aaaaaaaa', name: 'Engineering', idOnTheSource: 'entra-group-1' },
  ]),
});

describe('resolveUsageLabels', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.USAGE_PSEUDONYMIZATION_SECRET = 'test-secret';
    process.env.PILOT_TENANT_ID = TENANT_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('replaces user pseudonyms with the matching LibreChat user name', async () => {
    const result = await resolveUsageLabels(dashboard(), createDeps());

    expect(result.by_user[0]).toMatchObject({ key: USER_PSEUDONYM, label: 'Nikola Test (665f1)' });
    expect(result.by_user[1]).toMatchObject({
      key: UNKNOWN_PSEUDONYM,
      label: 'sha256:000000000000…',
    });
  });

  it('falls back to username or email when the user has no name', async () => {
    const deps = createDeps();
    deps.findUsers.mockResolvedValue([{ _id: USER_ID, email: 'nikola@example.com' }]);

    const result = await resolveUsageLabels(dashboard(), deps);

    expect(result.by_user[0].label).toBe('nikola@example.com (665f1)');
  });

  it('replaces group IDs and external group IDs with group names', async () => {
    const deps = createDeps();
    const result = await resolveUsageLabels(dashboard(), deps);

    expect(deps.findGroups).toHaveBeenCalledWith([
      '665f1c2e9b1e8a0087654321',
      'entra-group-1',
      'missing-group',
    ]);
    expect(result.by_team.map((team) => team.label)).toEqual([
      'Finance',
      'Engineering',
      'missing-group',
    ]);
    expect(result.by_model).toEqual(dashboard().by_model);
  });

  it('only shortens pseudonyms when the pseudonymization secret is not configured', async () => {
    delete process.env.USAGE_PSEUDONYMIZATION_SECRET;
    const deps = createDeps();

    const result = await resolveUsageLabels(dashboard(), deps);

    expect(deps.findUsers).not.toHaveBeenCalled();
    expect(result.by_user[0].label).toBe('sha256:d84316cbca2f…');
  });

  it('returns the original usage when a lookup fails', async () => {
    const deps = createDeps();
    deps.findGroups.mockRejectedValue(new Error('mongo down'));
    const usage = dashboard();

    const result = await resolveUsageLabels(usage, deps);

    expect(result).toBe(usage);
  });
});
