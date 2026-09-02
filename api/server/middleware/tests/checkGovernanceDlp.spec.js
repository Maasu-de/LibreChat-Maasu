const mockCheckTextSubmission = jest.fn();
const mockCreateDlpFailure = jest.fn();
const mockCreateDlpIntervention = jest.fn();
const mockIsGovernanceDlpEnabled = jest.fn();
const mockDenyRequest = jest.fn();

jest.mock('@librechat/api', () => ({
  checkTextSubmission: (...args) => mockCheckTextSubmission(...args),
  createDlpFailure: (...args) => mockCreateDlpFailure(...args),
  createDlpIntervention: (...args) => mockCreateDlpIntervention(...args),
  isGovernanceDlpEnabled: (...args) => mockIsGovernanceDlpEnabled(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

jest.mock(
  '../denyRequest',
  () =>
    (...args) =>
      mockDenyRequest(...args),
);

const checkGovernanceDlp = require('../checkGovernanceDlp');

describe('checkGovernanceDlp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsGovernanceDlpEnabled.mockReturnValue(true);
  });

  it('allows a normal plain-text submission to continue only after an ALLOW check', async () => {
    mockCheckTextSubmission.mockResolvedValue({ decision: 'ALLOW', findings: [] });
    const req = {
      body: {
        text: 'normal text',
        model: 'governed-model',
        endpointOption: { model_parameters: { model: 'governed-model' } },
      },
      user: { id: 'user-123' },
    };
    const next = jest.fn();

    await checkGovernanceDlp(req, {}, next);

    expect(mockCheckTextSubmission).toHaveBeenCalledWith({
      text: 'normal text',
      model: 'governed-model',
      userId: 'user-123',
    });
    expect(req.governanceDlpEligible).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockDenyRequest).not.toHaveBeenCalled();
  });

  it.each(['WARN', 'MASK'])(
    'allows a %s result to continue, leaving masking to the gateway-side DLP token',
    async (decision) => {
      const result = {
        decision,
        findings: [],
        maskedPreview:
          decision === 'MASK' ? [{ location: '/messages/0/content', text: 'masked text' }] : undefined,
        dlpToken: 'signed-dlp-token',
      };
      mockCheckTextSubmission.mockResolvedValue(result);
      const req = {
        body: {
          text: 'normal text',
          model: 'governed-model',
          endpointOption: { model_parameters: { model: 'governed-model' } },
        },
        user: { id: 'user-123' },
      };
      const next = jest.fn();

      await checkGovernanceDlp(req, {}, next);

      expect(mockCreateDlpIntervention).not.toHaveBeenCalled();
      expect(mockDenyRequest).not.toHaveBeenCalled();
      expect(req.governanceDlpEligible).toBe(true);
      expect(next).toHaveBeenCalledTimes(1);
    },
  );

  it('denies a BLOCK result through the shared SSE error path', async () => {
    const result = {
      decision: 'BLOCK',
      findings: [{ location: '/messages/0/content', start: 0, end: 4, category: 'ssn', action: 'BLOCK' }],
    };
    const body = {
      type: 'governance_blocked',
      decision: 'BLOCK',
      findings: result.findings,
    };
    mockCheckTextSubmission.mockResolvedValue(result);
    mockCreateDlpIntervention.mockReturnValue({ status: 403, body });
    const req = {
      body: { text: 'normal text', model: 'governed-model' },
      user: { id: 'user-123' },
    };
    const res = {};
    const next = jest.fn();

    await checkGovernanceDlp(req, res, next);

    expect(mockCreateDlpIntervention).toHaveBeenCalledWith(result);
    expect(mockDenyRequest).toHaveBeenCalledWith(req, res, body);
    expect(req.governanceDlpEligible).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('denies through the shared SSE error path when the check itself fails', async () => {
    const body = { type: 'governance_unavailable', message: 'try again later' };
    mockCheckTextSubmission.mockRejectedValue(new Error('gateway down'));
    mockCreateDlpFailure.mockReturnValue({ status: 503, body });
    const req = {
      body: { text: 'normal text', model: 'governed-model' },
      user: { id: 'user-123' },
    };
    const res = {};
    const next = jest.fn();

    await checkGovernanceDlp(req, res, next);

    expect(mockDenyRequest).toHaveBeenCalledWith(req, res, body);
    expect(next).not.toHaveBeenCalled();
  });
});
