import type { GovernanceFinding } from 'librechat-data-provider';
import { getGovernanceMasking } from '../mask';

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

describe('getGovernanceMasking', () => {
  it('uses the gateway replacement and original range for a custom category', () => {
    const finding: GovernanceFinding = {
      location: LOCATION,
      start: 8,
      end: 14,
      category: 'CUSTOM_CODENAMES',
      label: 'Codenames',
      action: 'MASK',
      replacement: '[REDACTED]',
    };

    expect(getGovernanceMasking('Discuss Apollo today', [finding])).toEqual({
      text: 'Discuss [REDACTED] today',
      ranges: [{ start: 8, end: 14, finding: 0 }],
    });
  });

  it('masks by code point like the gateway, with the original range of each replacement', () => {
    const text = '🙂 max@example.com and max@example.com';

    expect(getGovernanceMasking(text, [emailFinding(22), emailFinding(2)])).toEqual({
      text: '🙂 [EMAIL] and [EMAIL]',
      ranges: [
        { start: 2, end: 17, finding: 1 },
        { start: 22, end: 37, finding: 0 },
      ],
    });
  });

  it('masks the rest of a crossing finding without its leading whitespace, like the gateway', () => {
    const findings = [termFinding(8, 22), termFinding(0, 15)];

    expect(getGovernanceMasking(CROSSING_TERMS, findings)).toEqual({
      text: '[TERM] [TERM]',
      ranges: [
        { start: 0, end: 15, finding: 1 },
        { start: 16, end: 22, finding: 0 },
      ],
    });
  });

  it('drops a finding inside an earlier one like the gateway', () => {
    const findings = [termFinding(0, 7), termFinding(0, 15)];

    expect(getGovernanceMasking('Project Phoenix', findings)).toMatchObject({
      text: '[TERM]',
      ranges: [{ start: 0, end: 15, finding: 1 }],
    });
  });

  it('drops a crossing finding with only whitespace left to mask', () => {
    const findings = [termFinding(0, 7), termFinding(4, 9)];

    expect(getGovernanceMasking('Project  ', findings)).toEqual({
      text: '[TERM]  ',
      ranges: [{ start: 0, end: 7, finding: 0 }],
    });
  });

  it('keeps the text of findings without a replacement', () => {
    const warning = { ...emailFinding(0), action: 'WARN' as const, replacement: undefined };

    expect(getGovernanceMasking('max@example.com', [warning])).toEqual({
      text: 'max@example.com',
      ranges: [],
    });
  });

  it('gives an empty replacement its range of the original text', () => {
    const removed = { ...emailFinding(5), replacement: '' };

    expect(getGovernanceMasking('Mail max@example.com now', [removed])).toEqual({
      text: 'Mail  now',
      ranges: [{ start: 5, end: 20, finding: 0 }],
    });
  });
});
