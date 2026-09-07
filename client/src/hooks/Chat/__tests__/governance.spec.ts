import { hasSelectedEphemeralTools } from '../governance';

describe('hasSelectedEphemeralTools', () => {
  it.each([undefined, null, {}, { mcp: [] }])(
    'returns false when no ephemeral tools are selected',
    (ephemeralAgent) => {
      expect(hasSelectedEphemeralTools(ephemeralAgent)).toBe(false);
    },
  );

  it.each([
    { mcp: ['server'] },
    { web_search: true },
    { file_search: true },
    { execute_code: true },
  ])('returns true when an ephemeral tool is selected', (ephemeralAgent) => {
    expect(hasSelectedEphemeralTools(ephemeralAgent)).toBe(true);
  });
});
