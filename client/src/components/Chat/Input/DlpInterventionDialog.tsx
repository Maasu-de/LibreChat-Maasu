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
import { cn, getApprovedDlpText } from '~/utils';
import { useLocalize } from '~/hooks';

/** A finding covering a text segment, underlined on row `lane`; `ends` marks its last segment. */
type SegmentFinding = { finding: GovernanceFinding; lane: number; ends: boolean };
type TextSegment = { text: string; findings?: SegmentFinding[]; replacement?: boolean };
type FindingTerm = { finding: GovernanceFinding; term?: string };
type CategorizedFinding = Pick<GovernanceFinding, 'category' | 'label'>;

const label = (category: string) => category.replaceAll('_', ' ');

/**
 * Opaque keys of custom categories, which are never shown to the user. The gateway labels them
 * (`src/governance/category_labels.py` in ai-governance-gateway); this only covers reviews
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
  const categoryLabel = ({ category, label: displayName }: CategorizedFinding) => {
    if (displayName) {
      return displayName;
    }
    const key = CATEGORY_COPY[category];
    if (key) {
      return localize(key);
    }
    return category.startsWith(CUSTOM_CATEGORY_PREFIX)
      ? localize('com_ui_dlp_category_custom_term')
      : label(category);
  };
  const findingLabel = (finding: GovernanceFinding) =>
    `${categoryLabel(finding)}${finding.replacement ? ` → ${finding.replacement}` : ''}`;
  const originalSegments = useMemo(
    () => buildFindingSegments(originalText, result.findings),
    [originalText, result.findings],
  );
  const findingTerms = useMemo(
    () => buildFindingTerms(originalText, result.findings),
    [originalText, result.findings],
  );
  const maskedText = getApprovedDlpText(result);
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
              'border-transparent bg-aimo-fill leading-7 text-text-primary',
              originalSegments,
              (segment, index) => (
                <Fragment key={index}>
                  {segment.findings!.reduce<ReactNode>(
                    (content, { lane }) => (
                      <span
                        className="border-b-2 border-aimo-warn"
                        style={{ paddingBottom: 1 + lane * 4 }}
                      >
                        {content}
                      </span>
                    ),
                    <mark
                      title={segment
                        .findings!.map(({ finding }) => findingLabel(finding))
                        .join('\n')}
                      className="bg-aimo-warn-soft text-aimo-warn-ink"
                    >
                      {segment.text}
                      {segment.findings!.map(({ finding, ends }, i) =>
                        ends ? (
                          <span key={i} className="sr-only">
                            {` (${categoryLabel(finding)})`}
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
                <h3 className="mb-2 text-xs font-semibold tracking-[-0.01em] text-text-secondary">
                  {localize('com_ui_dlp_findings')}
                </h3>
                <ul className="flex flex-col gap-2">
                  {findingTerms.map(({ finding, term }, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs font-semibold tracking-[-0.01em]',
                          ACTION_CLASS[finding.action],
                        )}
                      >
                        {categoryLabel(finding)} · {localize(DECISION_COPY[finding.action])}
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
                            {categoryLabel(finding)} · {localize(DECISION_COPY[finding.action])}
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
