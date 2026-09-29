const checkGovernanceDlp = require('../checkGovernanceDlp');

describe('checkGovernanceDlp', () => {
  const originalEnabled = process.env.GOVERNANCE_DLP_ENABLED;

  beforeEach(() => {
    process.env.GOVERNANCE_DLP_ENABLED = 'true';
  });

  afterAll(() => {
    if (originalEnabled === undefined) {
      delete process.env.GOVERNANCE_DLP_ENABLED;
    } else {
      process.env.GOVERNANCE_DLP_ENABLED = originalEnabled;
    }
  });

  const run = (body) => {
    const req = { body, user: { id: 'user-123' } };
    const next = jest.fn();
    checkGovernanceDlp(req, {}, next);
    return { req, next };
  };

  it('marks a plain-text send for the governed approval flow', () => {
    const { req, next } = run({ text: 'normal text', model: 'governed-model' });

    expect(req.governanceDlpEligible).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['files', { files: [{ file_id: 'file-1' }] }],
    ['a regenerate', { isRegenerate: true }],
    ['an edit', { editedContent: { index: 0, type: 'text', text: 'edit' } }],
    ['a selected tool', { ephemeralAgent: { web_search: true } }],
  ])('leaves a send with %s unmarked', (_label, overrides) => {
    const { req, next } = run({ text: 'normal text', ...overrides });

    expect(req.governanceDlpEligible).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves every send unmarked while DLP is disabled', () => {
    process.env.GOVERNANCE_DLP_ENABLED = 'false';

    const { req, next } = run({ text: 'normal text' });

    expect(req.governanceDlpEligible).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
