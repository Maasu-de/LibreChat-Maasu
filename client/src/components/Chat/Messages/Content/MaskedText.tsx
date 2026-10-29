import { memo, useCallback } from 'react';
import type { GovernanceFinding, GovernanceMaskedSpan } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** A part of a masked message: its text as sent, and the mask when the gateway put it there. */
export type MaskedSegment = { text: string; mask?: GovernanceMaskedSpan };
/** A finding's category, with the gateway's display name when it is tenant-defined. */
export type CategorizedFinding = Pick<GovernanceFinding, 'category' | 'label'>;

/**
 * A value the gateway replaces, set in ink like a redaction bar. The bar never breaks across
 * lines, so the DLP dialog can reveal a value no wider than it in exactly its place.
 */
export const REDACTION_BAR =
  'inline-grid max-w-full justify-items-center rounded-sm px-1 py-0.5 leading-tight';
export const REDACTED = 'bg-text-primary text-surface-primary';

/**
 * Opaque keys of custom categories, which are never shown to the user. The gateway labels them
 * (`src/governance/category_labels.py` in ai-governance-gateway); this only covers findings
 * without a label.
 */
const CUSTOM_CATEGORY_PREFIX = 'CUSTOM_';

const CATEGORY_COPY: Partial<Record<string, TranslationKeys>> = {
  CLIENT_NAME: 'com_ui_dlp_category_client_name',
  CODE_NAME: 'com_ui_dlp_category_code_name',
  CREDIT_CARD: 'com_ui_dlp_category_credit_card',
  EMAIL_ADDRESS: 'com_ui_dlp_category_email_address',
  IBAN_CODE: 'com_ui_dlp_category_iban_code',
  PHONE_NUMBER: 'com_ui_dlp_category_phone_number',
  PROJECT_NAME: 'com_ui_dlp_category_project_name',
};

/**
 * Names a finding category by its display name, else its copy, else its identifier with spaces.
 * A custom category without a display name gets a generic name, never its key.
 */
export function useCategoryLabel(): (finding: CategorizedFinding) => string {
  const localize = useLocalize();
  return useCallback(
    ({ category, label }: CategorizedFinding) => {
      if (label) {
        return label;
      }
      const key = CATEGORY_COPY[category];
      if (key) {
        return localize(key);
      }
      return category.startsWith(CUSTOM_CATEGORY_PREFIX)
        ? localize('com_ui_dlp_category_custom_term')
        : category.replaceAll('_', ' ');
    },
    [localize],
  );
}

/**
 * Splits a sent message into its text and the gateway's replacements, in text order. Gives
 * nothing when a mask no longer matches the text, as after an edit, so it shows as written.
 */
export function getMaskedSegments(
  text: string,
  masks?: GovernanceMaskedSpan[],
): MaskedSegment[] | undefined {
  if (!masks || masks.length === 0) {
    return undefined;
  }
  const chars = Array.from(text);
  const segments: MaskedSegment[] = [];
  let cursor = 0;
  for (const mask of masks) {
    const { start, end, replacement } = mask;
    if (start < cursor || end <= start || chars.slice(start, end).join('') !== replacement) {
      return undefined;
    }
    if (start > cursor) {
      segments.push({ text: chars.slice(cursor, start).join('') });
    }
    segments.push({ text: replacement, mask });
    cursor = end;
  }
  if (cursor < chars.length) {
    segments.push({ text: chars.slice(cursor).join('') });
  }
  return segments;
}

/** A user message the gateway masked, with each replacement as a bar like in the DLP dialog. */
function MaskedText({ segments }: { segments: MaskedSegment[] }) {
  const localize = useLocalize();
  const categoryLabel = useCategoryLabel();
  return (
    <>
      {segments.map(({ text, mask }, index) =>
        mask ? (
          <mark key={index} className={cn(REDACTION_BAR, REDACTED)}>
            <span className="font-semibold">{text}</span>
            <span className="sr-only">
              {` (${categoryLabel(mask)} · ${localize('com_ui_dlp_decision_mask')})`}
            </span>
          </mark>
        ) : (
          <span key={index}>{text}</span>
        ),
      )}
    </>
  );
}

export default memo(MaskedText);
