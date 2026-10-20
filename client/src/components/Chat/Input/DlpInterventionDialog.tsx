import { useMemo } from 'react';
import { Button, OGDialog, OGDialogTemplate } from '@librechat/client';
import { GOVERNANCE_DLP_TEXT_LOCATION } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type {
  GovernanceDlpResult,
  GovernanceFinding,
  GovernanceDecision,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type TextSegment = { text: string; finding?: GovernanceFinding; replacement?: boolean };

const label = (category: string) => category.replaceAll('_', ' ');

const CATEGORY_COPY: Partial<Record<string, TranslationKeys>> = {
  CLIENT_NAME: 'com_ui_dlp_category_client_name',
  CODE_NAME: 'com_ui_dlp_category_code_name',
  CREDIT_CARD: 'com_ui_dlp_category_credit_card',
  EMAIL_ADDRESS: 'com_ui_dlp_category_email_address',
  IBAN_CODE: 'com_ui_dlp_category_iban_code',
  PHONE_NUMBER: 'com_ui_dlp_category_phone_number',
  PROJECT_NAME: 'com_ui_dlp_category_project_name',
};

const DECISION_COPY: Record<GovernanceDecision, TranslationKeys> = {
  ALLOW: 'com_ui_dlp_decision_allow',
  BLOCK: 'com_ui_dlp_decision_block',
  MASK: 'com_ui_dlp_decision_mask',
  WARN: 'com_ui_dlp_decision_warn',
};

const COPY = {
  ALLOW: { title: 'com_ui_dlp_mask_title', description: 'com_ui_dlp_mask_description' },
  MASK: { title: 'com_ui_dlp_mask_title', description: 'com_ui_dlp_mask_description' },
  WARN: { title: 'com_ui_dlp_warn_title', description: 'com_ui_dlp_warn_description' },
  BLOCK: { title: 'com_ui_dlp_block_title', description: 'com_ui_dlp_block_description' },
} as const satisfies Record<GovernanceDecision, { title: string; description: string }>;

const ACTION_CLASS: Record<GovernanceDecision, string> = {
  ALLOW: 'border-aimo-green bg-aimo-green-soft text-aimo-green-ink',
  MASK: 'border-aimo-mask bg-aimo-mask-soft text-aimo-mask-ink',
  WARN: 'border-aimo-warn bg-aimo-warn-soft text-aimo-warn-ink',
  BLOCK: 'border-aimo-block bg-aimo-block-soft text-aimo-block-ink',
};

export function buildFindingSegments(text: string, findings: GovernanceFinding[]): TextSegment[] {
  const chars = Array.from(text);
  const relevant = findings
    .filter(
      (f) =>
        f.location === GOVERNANCE_DLP_TEXT_LOCATION &&
        f.start >= 0 &&
        f.end > f.start &&
        f.start < chars.length,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const finding of relevant) {
    const start = Math.max(cursor, finding.start);
    const end = Math.min(chars.length, finding.end);
    if (start >= end) {
      continue;
    }
    if (start > cursor) {
      segments.push({ text: chars.slice(cursor, start).join('') });
    }
    segments.push({ text: chars.slice(start, end).join(''), finding });
    cursor = end;
  }
  if (cursor < chars.length) {
    segments.push({ text: chars.slice(cursor).join('') });
  }
  return segments.length ? segments : [{ text }];
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildReplacementSegments(
  text: string,
  findings: GovernanceFinding[],
): TextSegment[] {
  const tokens = [
    ...new Set(findings.map((f) => f.replacement).filter((r): r is string => Boolean(r))),
  ].sort((a, b) => b.length - a.length);
  if (!tokens.length) {
    return [{ text }];
  }
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'g');
  return text
    .split(pattern)
    .filter(Boolean)
    .map((segment) => ({ text: segment, replacement: tokens.includes(segment) }));
}

export default function DlpInterventionDialog({
  result,
  originalText,
  sendFailed = false,
  onCancel,
  onConfirm,
}: {
  result: GovernanceDlpResult;
  originalText: string;
  /** The approved message could not be sent, and can be sent again. */
  sendFailed?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const localize = useLocalize();
  const { decision } = result;
  const categoryLabel = (category: string) => {
    const key = CATEGORY_COPY[category];
    return key ? localize(key) : label(category);
  };
  const originalSegments = useMemo(
    () => buildFindingSegments(originalText, result.findings),
    [originalText, result.findings],
  );
  const maskedText = result.maskedPreview?.find(
    (m) => m.location === GOVERNANCE_DLP_TEXT_LOCATION,
  )?.text;
  const maskedSegments = useMemo(
    () => buildReplacementSegments(maskedText ?? '', result.findings),
    [maskedText, result.findings],
  );

  const textBlock = (
    heading: string,
    className: string,
    segments: TextSegment[],
    highlight: (segment: TextSegment, index: number) => ReactNode,
  ) => (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-[-0.01em] text-text-secondary">
        {heading}
      </h3>
      <div
        className={cn(
          'whitespace-pre-wrap rounded-xl border px-4 py-3 text-[17px] leading-[1.47]',
          className,
        )}
      >
        {segments.map((segment, index) =>
          segment.finding || segment.replacement ? (
            highlight(segment, index)
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </div>
    </section>
  );

  return (
    <OGDialog open onOpenChange={(open) => !open && onCancel()}>
      <OGDialogTemplate
        title={localize(COPY[decision].title)}
        description={localize(COPY[decision].description)}
        className="max-w-[640px]"
        headerClassName="[&_h2]:text-[28px] [&_h2]:leading-[1.14] [&_p]:text-sm [&_p]:tracking-[-0.016em]"
        showCancelButton={false}
        main={
          <div
            className="flex max-h-[65vh] flex-col gap-[18px] overflow-y-auto px-1"
            role="document"
          >
            {sendFailed && (
              <p
                role="alert"
                className="rounded-xl border border-aimo-block bg-aimo-block-soft px-4 py-3 text-sm text-aimo-block-ink"
              >
                {localize('com_ui_dlp_send_failed')}
              </p>
            )}
            {textBlock(
              localize('com_ui_dlp_original_prompt'),
              'border-transparent bg-aimo-fill text-text-primary',
              originalSegments,
              (segment, index) => (
                <mark
                  key={index}
                  title={categoryLabel(segment.finding!.category)}
                  className="rounded-md bg-aimo-warn-soft px-0.5 text-aimo-warn-ink outline outline-1 outline-aimo-warn"
                >
                  {segment.text}
                  <span className="sr-only"> ({categoryLabel(segment.finding!.category)})</span>
                </mark>
              ),
            )}

            {result.findings.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-[-0.01em] text-text-secondary">
                  {localize('com_ui_dlp_findings')}
                </h3>
                <ul className="flex flex-wrap gap-2">
                  {result.findings.map((finding, index) => (
                    <li
                      key={index}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs font-semibold tracking-[-0.01em]',
                        ACTION_CLASS[finding.action],
                      )}
                    >
                      {categoryLabel(finding.category)} · {localize(DECISION_COPY[finding.action])}
                      {finding.replacement ? ` → ${finding.replacement}` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {decision === 'MASK' && maskedText && (
              <>
                {textBlock(
                  localize('com_ui_dlp_masked_prompt'),
                  'border-aimo-line-solid bg-surface-dialog text-text-primary',
                  maskedSegments,
                  (segment, index) => (
                    <span
                      key={index}
                      className="rounded-md bg-aimo-mask-soft px-1 font-mono text-[15px] font-semibold text-aimo-mask-ink"
                    >
                      {segment.text}
                    </span>
                  ),
                )}
                <p className="text-xs text-text-secondary">
                  {localize('com_ui_dlp_replacement_explanation')}
                </p>
              </>
            )}
          </div>
        }
        buttons={
          <>
            <Button variant="outline" onClick={onCancel}>
              {localize(decision === 'BLOCK' ? 'com_ui_close' : 'com_ui_cancel')}
            </Button>
            {decision !== 'BLOCK' && (
              <Button variant={decision === 'WARN' ? 'default' : 'submit'} onClick={onConfirm}>
                {localize(decision === 'MASK' ? 'com_ui_dlp_send_masked' : 'com_ui_dlp_continue')}
              </Button>
            )}
          </>
        }
      />
    </OGDialog>
  );
}
