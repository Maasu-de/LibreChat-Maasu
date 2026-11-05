import type { GovernanceFinding, GovernanceMaskedRange } from 'librechat-data-provider';

/** The characters Python's `str.isspace()` matches, which the gateway skips when trimming. */
const GATEWAY_WHITESPACE =
  // eslint-disable-next-line no-control-regex
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;

/** A text as the gateway masks it, with the original range of each replacement. */
export interface GovernanceMasking {
  text: string;
  /** The ranges of the original text that the replacements take the place of, in text order. */
  ranges: GovernanceMaskedRange[];
}

/**
 * Applies each finding's replacement to the text like the gateway, using code-point offsets. A
 * finding inside an earlier one is dropped; a finding crossing an earlier one masks only the
 * rest, without its leading whitespace, so both keep their replacements. This mirrors
 * `_resolve_overlapping_mask_candidates` in the gateway's `src/governance/dlp.py`.
 */
export function getGovernanceMasking(
  text: string,
  findings: GovernanceFinding[],
): GovernanceMasking {
  const chars = Array.from(text);
  const candidates = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding.replacement !== undefined)
    .sort(({ finding: a }, { finding: b }) => a.start - b.start || b.end - a.end);

  const masking: GovernanceMasking = { text: '', ranges: [] };
  let covered = 0;
  let copied = 0;
  for (const { finding, index } of candidates) {
    const { start, end, replacement = '' } = finding;
    if (end <= covered) {
      continue;
    }
    let from = Math.max(start, covered);
    while (start < covered && from < end && GATEWAY_WHITESPACE.test(chars[from])) {
      from++;
    }
    covered = end;
    if (from >= end) {
      continue;
    }
    masking.ranges.push({ start: from, end, finding: index });
    masking.text += chars.slice(copied, from).join('') + replacement;
    copied = end;
  }
  masking.text += chars.slice(copied).join('');
  return masking;
}
