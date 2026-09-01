const mockCheckTextSubmission = jest.fn();
const mockCreateDlpFailure = jest.fn();
const mockCreateDlpIntervention = jest.fn();
const mockIsGovernanceDlpEnabled = jest.fn();

jest.mock('@librechat/api', () => ({
  checkTextSubmission: (...args) => mockCheckTextSubmission(...args),
  createDlpFailure: (...args) => mockCreateDlpFailure(...args),
  createDlpIntervention: (...args) => mockCreateDlpIntervention(...args),
  isGovernanceDlpEnabled: (...args) => mockIsGovernanceDlpEnabled(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

const checkGovernanceDlp = require('../checkGovernanceDlp');

const createResponse = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

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
    const res = createResponse();
    const next = jest.fn();

    await checkGovernanceDlp(req, res, next);

    expect(mockCheckTextSubmission).toHaveBeenCalledWith({
      text: 'normal text',
      model: 'governed-model',
      userId: 'user-123',
    });
    expect(req.governanceDlpEligible).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes a MASK result to the existing intervention response path', async () => {
    const result = {
      decision: 'MASK',
      findings: [],
      maskedPreview: [{ location: '/messages/0/content', text: 'masked text' }],
      dlpToken: 'signed-dlp-token',
    };
    const intervention = {
      status: 422,
      body: {
        type: 'governance_intervention',
        decision: 'MASK',
        findings: result.findings,
        masked_preview: result.maskedPreview,
        dlp_token: result.dlpToken,
      },
    };
    mockCheckTextSubmission.mockResolvedValue(result);
    mockCreateDlpIntervention.mockReturnValue(intervention);
    const req = {
      body: { text: 'normal text', model: 'governed-model' },
      user: { id: 'user-123' },
    };
    const res = createResponse();
    const next = jest.fn();

    await checkGovernanceDlp(req, res, next);

    expect(mockCreateDlpIntervention).toHaveBeenCalledWith(result);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(intervention.body);
    expect(next).not.toHaveBeenCalled();
  });
});
