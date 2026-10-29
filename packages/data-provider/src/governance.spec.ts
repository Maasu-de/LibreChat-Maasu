import type { GovernanceFinding } from './types/governance';
import { maskGovernanceText, getGovernanceMasking, getGovernanceMaskRanges } from './governance';

const LOCATION = '/messages/0/content';
const CROSSING_TERMS = 'Project Phoenix Secret';

const emailFinding = (start: number): GovernanceFinding => ({
  location: LOCATION,
  start,
  end: start + 'max@example.com'.length,
  category: 'EMAIL_ADDRESS',
  action: 'MASK',
  replacement: '[EMAIL]',
});

const termFinding = (start: number, end: number): GovernanceFinding => ({
  location: LOCATION,
  start,
  end,
  category: 'TENANT_TERM',
  action: 'MASK',
  replacement: '[TERM]',
});

describe('maskGovernanceText', () => {
  it('masks by code point like the gateway', () => {
    const text = '🙂 max@example.com and max@example.com';

    expect(maskGovernanceText(text, [emailFinding(2), emailFinding(22)])).toBe(
      '🙂 [EMAIL] and [EMAIL]',
    );
  });

  it('masks the rest of a crossing finding like the gateway', () => {
    const findings = [termFinding(0, 15), termFinding(8, 22)];

    expect(maskGovernanceText(CROSSING_TERMS, findings)).toBe('[TERM] [TERM]');
  });

  it('drops a finding inside an earlier one like the gateway', () => {
    const findings = [termFinding(0, 7), termFinding(0, 15)];

    expect(maskGovernanceText('Project Phoenix', findings)).toBe('[TERM]');
  });

  it('keeps the text of findings without a replacement', () => {
    const warning = { ...emailFinding(0), action: 'WARN' as const, replacement: undefined };

    expect(maskGovernanceText('max@example.com', [warning])).toBe('max@example.com');
  });
});

describe('getGovernanceMasking', () => {
  it('gives the code-point range of each replacement in the masked text', () => {
    const text = '🙂 max@example.com and max@example.com';

    expect(getGovernanceMasking(text, [emailFinding(22), emailFinding(2)])).toEqual({
      text: '🙂 [EMAIL] and [EMAIL]',
      masks: [
        { start: 2, end: 9, category: 'EMAIL_ADDRESS', replacement: '[EMAIL]' },
        { start: 14, end: 21, category: 'EMAIL_ADDRESS', replacement: '[EMAIL]' },
      ],
    });
  });

  it('gives a crossing finding the range of its own replacement', () => {
    const findings = [termFinding(0, 15), termFinding(8, 22)];

    expect(getGovernanceMasking(CROSSING_TERMS, findings).masks).toEqual([
      { start: 0, end: 6, category: 'TENANT_TERM', replacement: '[TERM]' },
      { start: 7, end: 13, category: 'TENANT_TERM', replacement: '[TERM]' },
    ]);
  });

  it('gives no range to a finding without a replacement', () => {
    const warning = { ...emailFinding(0), action: 'WARN' as const, replacement: undefined };

    expect(getGovernanceMasking('max@example.com', [warning]).masks).toEqual([]);
  });
});

describe('getGovernanceMaskRanges', () => {
  it('gives each masked finding the range its replacement covers, in text order', () => {
    const later = termFinding(8, 22);
    const earlier = termFinding(0, 15);

    expect(getGovernanceMaskRanges(Array.from(CROSSING_TERMS), [later, earlier])).toEqual([
      { start: 0, end: 15, finding: earlier },
      { start: 16, end: 22, finding: later },
    ]);
  });

  it('gives no range to a crossing finding with only whitespace left to mask', () => {
    const earlier = termFinding(0, 7);

    expect(getGovernanceMaskRanges(Array.from('Project  '), [earlier, termFinding(4, 9)])).toEqual([
      { start: 0, end: 7, finding: earlier },
    ]);
  });
});
