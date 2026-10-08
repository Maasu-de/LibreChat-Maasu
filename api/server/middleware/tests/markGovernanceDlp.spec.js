const mockGetUserGroupIds = jest.fn();
const mockDenyRequest = jest.fn();

jest.mock('~/server/services/governanceGroups', () => ({
  getUserGroupIds: (...args) => mockGetUserGroupIds(...args),
}));
jest.mock(
  '../denyRequest',
  () =>
    (...args) =>
      mockDenyRequest(...args),
);

const markGovernanceDlp = require('../markGovernanceDlp');

describe('markGovernanceDlp', () => {
  const originalEnabled = process.env.GOVERNANCE_DLP_ENABLED;
  const originalPilot = process.env.GOVERNANCE_PILOT_ENABLED;

  beforeEach(() => {
    process.env.GOVERNANCE_DLP_ENABLED = 'true';
    delete process.env.GOVERNANCE_PILOT_ENABLED;
    mockGetUserGroupIds.mockReset();
    mockGetUserGroupIds.mockResolvedValue(['group-1', 'group-2']);
    mockDenyRequest.mockReset();
  });

  afterAll(() => {
    for (const [name, value] of [
      ['GOVERNANCE_DLP_ENABLED', originalEnabled],
      ['GOVERNANCE_PILOT_ENABLED', originalPilot],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  const run = async (body) => {
    const req = { body, user: { id: 'user-123' } };
    const next = jest.fn();
    await markGovernanceDlp(req, {}, next);
    return { req, next };
  };

  it('marks a plain-text send for the governed approval flow with the user groups', async () => {
    const { req, next } = await run({ text: 'normal text', model: 'governed-model' });

    expect(req.governanceDlpEligible).toBe(true);
    expect(req.governanceGroupIds).toEqual(['group-1', 'group-2']);
    expect(mockGetUserGroupIds).toHaveBeenCalledWith('user-123');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['files', { files: [{ file_id: 'file-1' }] }],
    ['a regenerate', { isRegenerate: true }],
    ['an edit', { editedContent: { index: 0, type: 'text', text: 'edit' } }],
    ['a selected tool', { ephemeralAgent: { web_search: true } }],
  ])('leaves a send with %s unmarked', async (_label, overrides) => {
    const { req, next } = await run({ text: 'normal text', ...overrides });

    expect(req.governanceDlpEligible).toBe(false);
    expect(req.governanceGroupIds).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves every send unmarked while DLP is disabled', async () => {
    process.env.GOVERNANCE_DLP_ENABLED = 'false';

    const { req, next } = await run({ text: 'normal text' });

    expect(req.governanceDlpEligible).toBe(false);
    expect(mockGetUserGroupIds).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('resolves the user groups for every send in pilot mode', async () => {
    process.env.GOVERNANCE_PILOT_ENABLED = 'true';

    const { req, next } = await run({ text: 'normal text', files: [{ file_id: 'file-1' }] });

    expect(req.governanceDlpEligible).toBe(false);
    expect(req.governanceGroupIds).toEqual(['group-1', 'group-2']);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('refuses a governed send when the user groups cannot be resolved', async () => {
    mockGetUserGroupIds.mockRejectedValue(new Error('database unavailable'));

    const { req, next } = await run({ text: 'normal text' });

    expect(next).not.toHaveBeenCalled();
    expect(mockDenyRequest).toHaveBeenCalledWith(req, {}, expect.any(String));
  });
});
