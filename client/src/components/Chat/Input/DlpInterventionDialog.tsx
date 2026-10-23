import { Fragment, useMemo } from 'react';
import { Button, OGDialog, OGDialogTemplate } from '@librechat/client';
import { GOVERNANCE_DLP_TEXT_LOCATION } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type {
  GovernanceDlpResult,
  GovernanceFinding,
  GovernanceDecision,
  GovernanceFileFinding,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** A finding covering a text segment, underlined on row `lane`; `ends` marks its last segment. */
type SegmentFinding = { finding: GovernanceFinding; lane: number; ends: boolean };
type TextSegment = { text: string; findings?: SegmentFinding[]; replacement?: boolean };
type FindingTerm = { finding: GovernanceFinding; term?: string };

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
  ALLOW:
    'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200',
  MASK: 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200',
  WARN: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  BLOCK:
    'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
};

const byPosition = (a: GovernanceFinding, b: GovernanceFinding) =>
  a.start - b.start || b.end - a.end;

const isInText = (chars: string[], f: GovernanceFinding) =>
  f.location === GOVERNANCE_DLP_TEXT_LOCATION &&
  f.start >= 0 &&
  f.end > f.start &&
  f.start < chars.length;

/**
 * Splits the text at every finding boundary. Each finding keeps its whole span on the first
 * underline row that is free there, so overlapping findings are each underlined in full.
 */
export function buildFindingSegments(text: string, findings: GovernanceFinding[]): TextSegment[] {
  const chars = Array.from(text);
  const laneEnds: number[] = [];
  const laned = findings
    .filter((f) => isInText(chars, f))
    .map((f) => (f.end > chars.length ? { ...f, end: chars.length } : f))
    .sort(byPosition)
    .map((finding) => {
      const free = laneEnds.findIndex((end) => end <= finding.start);
      const lane = free === -1 ? laneEnds.length : free;
      laneEnds[lane] = finding.end;
      return { finding, lane };
    });
  if (laned.length === 0) {
    return [{ text }];
  }

  const boundaries = [
    ...new Set([0, chars.length, ...laned.flatMap(({ finding }) => [finding.start, finding.end])]),
  ].sort((a, b) => a - b);

  const segments: TextSegment[] = [];
  let active: Omit<SegmentFinding, 'ends'>[] = [];
  let next = 0;
  for (let i = 1; i < boundaries.length; i++) {
    const from = boundaries[i - 1];
    const to = boundaries[i];
    active = active.filter(({ finding }) => finding.end > from);
    while (next < laned.length && laned[next].finding.start === from) {
      active.push(laned[next++]);
    }
    const segment: TextSegment = { text: chars.slice(from, to).join('') };
    if (active.length) {
      segment.findings = active
        .map((f) => ({ ...f, ends: f.finding.end === to }))
        .sort((a, b) => a.lane - b.lane);
    }
    segments.push(segment);
  }
  return segments;
}

/** Every finding in text order, with the submitted text it covers when it lies in that text. */
export function buildFindingTerms(text: string, findings: GovernanceFinding[]): FindingTerm[] {
  const chars = Array.from(text);
  return [...findings].sort(byPosition).map((finding) => ({
    finding,
    term: isInText(chars, finding) ? chars.slice(finding.start, finding.end).join('') : undefined,
  }));
}

/** Groups file findings by file, keeping the order in which the files first appear. */
export function groupFileFindings(
  fileFindings: GovernanceFileFinding[] = [],
): [string, GovernanceFileFinding[]][] {
  const byFile = new Map<string, GovernanceFileFinding[]>();
  for (const finding of fileFindings) {
    byFile.set(finding.filename, [...(byFile.get(finding.filename) ?? []), finding]);
  }
  return Array.from(byFile.entries());
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
  const findingLabel = ({ category, replacement }: GovernanceFinding) =>
    `${categoryLabel(category)}${replacement ? ` → ${replacement}` : ''}`;
  const originalSegments = useMemo(
    () => buildFindingSegments(originalText, result.findings),
    [originalText, result.findings],
  );
  const findingTerms = useMemo(
    () => buildFindingTerms(originalText, result.findings),
    [originalText, result.findings],
  );
  const maskedText = result.maskedPreview?.find(
    (m) => m.location === GOVERNANCE_DLP_TEXT_LOCATION,
  )?.text;
  const files = useMemo(() => groupFileFindings(result.fileFindings), [result.fileFindings]);
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
          segment.findings || segment.replacement ? (
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
            {sendFailed && (
              <p
                role="alert"
                className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
              >
                {localize('com_ui_dlp_send_failed')}
              </p>
            )}
            {textBlock(
              localize('com_ui_dlp_original_prompt'),
              'border-border-light bg-surface-secondary leading-7 text-text-primary',
              originalSegments,
              (segment, index) => (
                <Fragment key={index}>
                  {segment.findings!.reduce<ReactNode>(
                    (content, { lane }) => (
                      <span
                        className="border-b-2 border-amber-600 dark:border-amber-400"
                        style={{ paddingBottom: 1 + lane * 4 }}
                      >
                        {content}
                      </span>
                    ),
                    <mark
                      title={segment
                        .findings!.map(({ finding }) => findingLabel(finding))
                        .join('\n')}
                      className="bg-amber-200 text-gray-950 dark:bg-amber-700 dark:text-white"
                    >
                      {segment.text}
                      {segment.findings!.map(({ finding, ends }, i) =>
                        ends ? (
                          <span key={i} className="sr-only">
                            {` (${categoryLabel(finding.category)})`}
                          </span>
                        ) : null,
                      )}
                    </mark>,
                  )}
                </Fragment>
              ),
            )}

            {result.findings.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-text-primary">
                  {localize('com_ui_dlp_findings')}
                </h3>
                <ul className="flex flex-col gap-2">
                  {findingTerms.map(({ finding, term }, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs font-medium',
                          ACTION_CLASS[finding.action],
                        )}
                      >
                        {categoryLabel(finding.category)} ·{' '}
                        {localize(DECISION_COPY[finding.action])}
                      </span>
                      {term && <span className="break-all text-text-primary">{term}</span>}
                      {finding.replacement && (
                        <span className="font-mono text-text-secondary">
                          → {finding.replacement}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {files.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-text-primary">
                  {localize('com_ui_dlp_file_findings')}
                </h3>
                <ul className="flex flex-col gap-3">
                  {files.map(([filename, findings]) => (
                    <li key={filename}>
                      <p className="mb-1 break-all text-sm text-text-primary">{filename}</p>
                      <ul className="flex flex-wrap gap-2">
                        {findings.map((finding) => (
                          <li
                            key={`${finding.category}-${finding.action}`}
                            className={cn(
                              'rounded-full border px-2.5 py-1 text-xs font-medium',
                              ACTION_CLASS[finding.action],
                            )}
                          >
                            {categoryLabel(finding.category)} ·{' '}
                            {localize(DECISION_COPY[finding.action])}
                            {finding.count > 1 ? ` × ${finding.count}` : ''}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {decision === 'MASK' && maskedText && result.findings.length > 0 && (
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
