import { useCallback } from 'react';
import type { GovernanceFinding } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

/** A finding's category, with the gateway's display name when it is tenant-defined. */
export type CategorizedFinding = Pick<GovernanceFinding, 'category' | 'label'>;

/** A detected value marked in text, readable on the color of its finding's action. */
export const FLAGGED = 'rounded-sm box-decoration-clone px-0.5 text-inherit';
/** A replacement the gateway sent in place of a detected value, in the dialog and in the chat. */
export const MASKED_VALUE = `${FLAGGED} bg-aimo-mask/35 font-medium`;

const CUSTOM_CATEGORY_PREFIX = 'CUSTOM_';

const CATEGORY_COPY: Partial<Record<string, TranslationKeys>> = {
  CLIENT_NAME: 'com_ui_dlp_category_client_name',
  CODE_NAME: 'com_ui_dlp_category_code_name',
  CREDIT_CARD: 'com_ui_dlp_category_credit_card',
  DE_SOCIAL_SECURITY_NUMBER: 'com_ui_dlp_category_de_social_security_number',
  EMAIL_ADDRESS: 'com_ui_dlp_category_email_address',
  GERMAN_ID_CARD: 'com_ui_dlp_category_german_id_card',
  GERMAN_PASSPORT: 'com_ui_dlp_category_german_passport',
  GERMAN_TAX_ID: 'com_ui_dlp_category_german_tax_id',
  IBAN_CODE: 'com_ui_dlp_category_iban_code',
  PHONE_NUMBER: 'com_ui_dlp_category_phone_number',
  PROJECT_NAME: 'com_ui_dlp_category_project_name',
  VAT_ID: 'com_ui_dlp_category_vat_id',
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
        : category.charAt(0) + category.slice(1).replaceAll('_', ' ').toLowerCase();
    },
    [localize],
  );
}
