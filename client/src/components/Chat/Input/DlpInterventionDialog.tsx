import { useMemo } from 'react';
import { Button, OGDialog, OGDialogTemplate } from '@librechat/client';
import type { ReactNode } from 'react';
import type {
  GovernanceDlpResult,
  GovernanceFinding,
  GovernanceDecision,
} from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type TextSegment = { text: string; finding?: GovernanceFinding; replacement?: boolean };

const MESSAGE_LOCATION = '/messages/0/content';
const label = (category: string) => category.replaceAll('_', ' ');

const COPY = {
  ALLOW: { title: 'com_ui_dlp_mask_title', description: 'com_ui_dlp_mask_description' },
  MASK: { title: 'com_ui_dlp_mask_title', description: 'com_ui_dlp_mask_description' },
  WARN: { title: 'com_ui_dlp_warn_title', description: 'com_ui_dlp_warn_description' },
  BLOCK: { title: 'com_ui_dlp_block_title', description: 'com_ui_dlp_block_description' },
} as const satisfies Record<GovernanceDecision, { title: string; description: string }>;

const ACTION_CLASS: Record<GovernanceDecision, string> = {
  ALLOW:
    'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200',
  MASK: 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200',
  WARN: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  BLOCK:
    'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
};

export function buildFindingSegments(text: string, findings: GovernanceFinding[]): TextSegment[] {
  const chars = Array.from(text);
  const relevant = findings
    .filter(
      (f) =>
        f.location === MESSAGE_LOCATION &&
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
  onCancel,
  onConfirm,
}: {
  result: GovernanceDlpResult;
  originalText: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const localize = useLocalize();
  const { decision } = result;
  const originalSegments = useMemo(
    () => buildFindingSegments(originalText, result.findings),
    [originalText, result.findings],
  );
  const maskedText = result.maskedPreview?.find((m) => m.location === MESSAGE_LOCATION)?.text;
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
      <h3 className="mb-2 text-sm font-semibold text-text-primary">{heading}</h3>
      <div className={cn('whitespace-pre-wrap rounded-lg border p-3 text-sm', className)}>
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
        className="max-w-2xl"
        showCancelButton={false}
        main={
          <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto px-1" role="document">
            {textBlock(
              localize('com_ui_dlp_original_prompt'),
              'border-border-light bg-surface-secondary text-text-primary',
              originalSegments,
              (segment, index) => (
                <mark
                  key={index}
                  title={label(segment.finding!.category)}
                  className="rounded bg-amber-200 px-0.5 text-gray-950 outline outline-1 outline-amber-500 dark:bg-amber-700 dark:text-white"
                >
                  {segment.text}
                  <span className="sr-only"> ({label(segment.finding!.category)})</span>
                </mark>
              ),
            )}

            {result.findings.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-text-primary">
                  {localize('com_ui_dlp_findings')}
                </h3>
                <ul className="flex flex-wrap gap-2">
                  {result.findings.map((finding, index) => (
                    <li
                      key={index}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs font-medium',
                        ACTION_CLASS[finding.action],
                      )}
                    >
                      {label(finding.category)} · {finding.action}
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
                  'border-blue-300 bg-blue-50 text-gray-950 dark:border-blue-800 dark:bg-blue-950/30 dark:text-white',
                  maskedSegments,
                  (segment, index) => (
                    <span
                      key={index}
                      className="rounded bg-blue-200 px-1 font-mono font-semibold text-blue-950 dark:bg-blue-800 dark:text-blue-100"
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
