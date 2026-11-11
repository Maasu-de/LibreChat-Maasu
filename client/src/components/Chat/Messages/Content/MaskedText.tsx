import type { GovernanceMask } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { MASKED_VALUE, useCategoryLabel } from '~/components/Chat/Input/labels';
import { useLocalize } from '~/hooks';

/** A sent message's text with each replacement the gateway put in it marked with its category. */
export default function MaskedText({ text, masks }: { text: string; masks: GovernanceMask[] }) {
  const localize = useLocalize();
  const categoryLabel = useCategoryLabel();
  const chars = Array.from(text);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const mask of masks) {
    if (mask.start < at || mask.end > chars.length) {
      continue;
    }
    const label = categoryLabel(mask);
    parts.push(chars.slice(at, mask.start).join(''));
    parts.push(
      <mark key={mask.start} title={label} className={MASKED_VALUE}>
        {chars.slice(mask.start, mask.end).join('')}
        <span className="sr-only">{` (${localize('com_ui_dlp_masked_value', { 0: label })})`}</span>
      </mark>,
    );
    at = mask.end;
  }
  parts.push(chars.slice(at).join(''));
  return <>{parts}</>;
}
