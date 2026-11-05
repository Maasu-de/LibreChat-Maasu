import { useCallback } from 'react';
import type { GovernanceFinding } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

/** A finding's category, with the gateway's display name when it is tenant-defined. */
export type CategorizedFinding = Pick<GovernanceFinding, 'category' | 'label'>;

/** A bar stays on one line so a revealed value can occupy the same place. */
export const REDACTION_BAR =
  'inline-grid max-w-full justify-items-center rounded-sm px-1 py-0.5 leading-tight';
export const REDACTED = 'bg-text-primary text-surface-primary';

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

/** Names a category without exposing an opaque custom-category key. */
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
