import type { GovernanceFinding, GovernanceMaskedSpan } from './types/governance';

/** The characters Python's `str.isspace()` matches, which the gateway skips when trimming. */
const GATEWAY_WHITESPACE =
  // eslint-disable-next-line no-control-regex
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;

/** A code-point range of a text that the gateway replaces with its finding's replacement. */
export interface GovernanceMaskRange {
  start: number;
  end: number;
  finding: GovernanceFinding;
}

/**
 * The ranges of `chars` the gateway masks, in text order. A finding inside an earlier one is
 * dropped; a finding crossing an earlier one masks only the rest, without its leading
 * whitespace, so both keep their replacements. This mirrors
 * `_resolve_overlapping_mask_candidates` in the gateway's `src/governance/dlp.py`.
 */
export function getGovernanceMaskRanges(
  chars: string[],
  findings: GovernanceFinding[],
): GovernanceMaskRange[] {
  const masks = findings
    .filter((finding) => finding.replacement !== undefined)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const ranges: GovernanceMaskRange[] = [];
  let cursor = 0;
  for (const finding of masks) {
    const { start, end } = finding;
    if (end <= cursor) {
      continue;
    }
    let from = Math.max(start, cursor);
    while (start < cursor && from < end && GATEWAY_WHITESPACE.test(chars[from])) {
      from++;
    }
    if (from < end) {
      ranges.push({ start: from, end, finding });
    }
    cursor = end;
  }
  return ranges;
}

/**
 * Applies each finding's replacement to the text like the gateway, using code-point offsets, and
 * gives the range each replacement takes in the masked text.
 */
export function getGovernanceMasking(
  text: string,
  findings: GovernanceFinding[],
): { text: string; masks: GovernanceMaskedSpan[] } {
  const chars = Array.from(text);
  const masks: GovernanceMaskedSpan[] = [];
  let masked = '';
  let cursor = 0;
  let offset = 0;
  for (const { start, end, finding } of getGovernanceMaskRanges(chars, findings)) {
    const replacement = finding.replacement ?? '';
    const length = Array.from(replacement).length;
    offset += start - cursor;
    if (length > 0) {
      masks.push({ start: offset, end: offset + length, category: finding.category, replacement });
    }
    masked += chars.slice(cursor, start).join('') + replacement;
    offset += length;
    cursor = end;
  }
  return { text: masked + chars.slice(cursor).join(''), masks };
}

/** Applies each finding's replacement to the text like the gateway, using code-point offsets. */
export const maskGovernanceText = (text: string, findings: GovernanceFinding[]): string =>
  getGovernanceMasking(text, findings).text;
