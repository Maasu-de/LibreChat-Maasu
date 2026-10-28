import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { Button, OGDialog, OGDialogTemplate } from '@librechat/client';
import {
  FileSources,
  getGovernanceMaskRanges,
  GOVERNANCE_DLP_TEXT_LOCATION,
} from 'librechat-data-provider';
import type {
  GovernanceDlpResult,
  GovernanceFinding,
  GovernanceDecision,
  GovernanceFileFinding,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks';
import FilePreview from './Files/FilePreview';
import { cn, getFileType } from '~/utils';
import { useLocalize } from '~/hooks';

/** A finding with the key that highlights its value, set when it lies in the text. */
export type KeyedFinding = GovernanceFinding & { key?: string };
/** A finding covering a text segment, underlined on row `lane`; `ends` marks its last segment. */
type SegmentFinding<F extends GovernanceFinding> = { finding: F; lane: number; ends: boolean };
type TextSegment<F extends GovernanceFinding> = { text: string; findings?: SegmentFinding<F>[] };
type TextInterval<F extends GovernanceFinding> = {
  start: number;
  end: number;
  findings: SegmentFinding<F>[];
};
/** Masked text: kept text or the replacement of `replaced`, with the findings it stands for. */
type MaskedSegment<F extends GovernanceFinding> = {
  text: string;
  findings: F[];
  replaced?: GovernanceFinding;
};
/** The findings of one category and action in a file, with the distinct values they matched. */
type FindingGroup = Pick<
  GovernanceFileFinding,
  'category' | 'label' | 'action' | 'count' | 'terms'
>;
/** The findings in one attached file, whose MIME type picks its icon like in the composer. */
type FileFindings = { id: string; filename: string; type?: string; groups: FindingGroup[] };
type CategorizedFinding = Pick<GovernanceFinding, 'category' | 'label'>;
type ActionStyle = { chip: string; underline: string; ink: string; highlight: string };

/** How many matched values the popup of a finding badge lists; the rest are only counted. */
const VISIBLE_TERMS = 50;
/** Grace period so moving the pointer from a badge to its popup doesn't close it. */
const CLOSE_DELAY_MS = 120;
const SEVERITY: GovernanceDecision[] = ['ALLOW', 'WARN', 'MASK', 'BLOCK'];

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

/** The box that holds both the original and the masked prompt. */
const PROMPT_BOX =
  'whitespace-pre-wrap break-words rounded-xl bg-aimo-fill px-4 py-3 text-[17px] leading-8 text-text-primary dark:bg-aimo-ink-3';
const BADGE =
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold tracking-[-0.01em] transition-colors';

const ACTION_STYLE: Record<GovernanceDecision, ActionStyle> = {
  ALLOW: {
    chip: 'border-aimo-green bg-aimo-green-soft text-aimo-green-ink',
    underline: 'border-aimo-green',
    ink: 'text-aimo-green-ink',
    highlight: 'bg-aimo-green/25',
  },
  MASK: {
    chip: 'border-aimo-mask bg-aimo-mask-soft text-aimo-mask-ink',
    underline: 'border-aimo-mask',
    ink: 'text-aimo-mask-ink',
    highlight: 'bg-aimo-mask/35',
  },
  WARN: {
    chip: 'border-aimo-warn bg-aimo-warn-soft text-aimo-warn-ink',
    underline: 'border-aimo-warn',
    ink: 'text-aimo-warn-ink',
    highlight: 'bg-aimo-warn/25',
  },
  BLOCK: {
    chip: 'border-aimo-block bg-aimo-block-soft text-aimo-block-ink',
    underline: 'border-aimo-block',
    ink: 'text-aimo-block-ink',
    highlight: 'bg-aimo-block/20',
  },
};

const byPosition = (a: GovernanceFinding, b: GovernanceFinding) =>
  a.start - b.start || b.end - a.end;

const isInText = (chars: string[], f: GovernanceFinding) =>
  f.location === GOVERNANCE_DLP_TEXT_LOCATION &&
  f.start >= 0 &&
  f.end > f.start &&
  f.start < chars.length;

const mostSevere = (findings: GovernanceFinding[]) =>
  findings.reduce<GovernanceDecision>(
    (action, finding) =>
      SEVERITY.indexOf(finding.action) > SEVERITY.indexOf(action) ? finding.action : action,
    'ALLOW',
  );

/** Names a value of a category wherever it occurs, so all its occurrences highlight together. */
export const termKey = (category: string, term: string): string =>
  `${category}\n${term.replace(/\s+/g, ' ').trim().toLowerCase()}`;

const uniqueTerms = (category: string, terms: string[]) => {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = termKey(category, term);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/** Clips each finding in the text to it, adding the key of the value it matched. */
export function keyFindings(text: string, findings: GovernanceFinding[]): KeyedFinding[] {
  const chars = Array.from(text);
  return findings.map((finding) => {
    if (!isInText(chars, finding)) {
      return finding;
    }
    const end = Math.min(finding.end, chars.length);
    const key = termKey(finding.category, chars.slice(finding.start, end).join(''));
    return { ...finding, end, key };
  });
}

/**
 * Splits the text at every finding boundary and at `cuts`. Each finding keeps its whole span on
 * the first underline row that is free there, so overlapping findings are each underlined in full.
 */
function splitAtFindings<F extends GovernanceFinding>(
  chars: string[],
  findings: F[],
  cuts: number[] = [],
): TextInterval<F>[] {
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

  const boundaries = [
    ...new Set([
      0,
      chars.length,
      ...cuts.filter((cut) => cut > 0 && cut < chars.length),
      ...laned.flatMap(({ finding }) => [finding.start, finding.end]),
    ]),
  ].sort((a, b) => a - b);

  const intervals: TextInterval<F>[] = [];
  let active: Omit<SegmentFinding<F>, 'ends'>[] = [];
  let next = 0;
  for (let i = 1; i < boundaries.length; i++) {
    const from = boundaries[i - 1];
    const to = boundaries[i];
    active = active.filter(({ finding }) => finding.end > from);
    while (next < laned.length && laned[next].finding.start === from) {
      active.push(laned[next++]);
    }
    intervals.push({
      start: from,
      end: to,
      findings: active
        .map((f) => ({ ...f, ends: f.finding.end === to }))
        .sort((a, b) => a.lane - b.lane),
    });
  }
  return intervals;
}

/** Splits the text into segments that each lie inside the same findings, in text order. */
export function buildFindingSegments<F extends GovernanceFinding>(
  text: string,
  findings: F[],
): TextSegment<F>[] {
  const chars = Array.from(text);
  return splitAtFindings(chars, findings).map(({ start, end, findings: covering }) => {
    const segment = chars.slice(start, end).join('');
    return covering.length > 0 ? { text: segment, findings: covering } : { text: segment };
  });
}

/**
 * Splits the masked text into the text it keeps and the replacements the gateway puts in, each
 * with the findings of the original text it stands for.
 */
export function buildMaskedSegments<F extends GovernanceFinding>(
  text: string,
  findings: F[],
): MaskedSegment<F>[] {
  const chars = Array.from(text);
  const ranges = getGovernanceMaskRanges(chars, findings);
  const intervals = splitAtFindings(
    chars,
    findings,
    ranges.flatMap(({ start, end }) => [start, end]),
  );

  const segments: MaskedSegment<F>[] = [];
  let r = 0;
  for (const { start, end, findings: covering } of intervals) {
    while (r < ranges.length && ranges[r].end <= start) {
      r++;
    }
    const range = ranges[r];
    const covered = covering.map(({ finding }) => finding);
    if (range === undefined || range.start > start) {
      segments.push({ text: chars.slice(start, end).join(''), findings: covered });
      continue;
    }
    const last = segments[segments.length - 1];
    if (start > range.start && last?.replaced === range.finding) {
      last.findings = [...new Set([...last.findings, ...covered])];
      continue;
    }
    segments.push({
      text: range.finding.replacement ?? '',
      findings: covered,
      replaced: range.finding,
    });
  }
  return segments;
}

/**
 * The findings in each attached file, grouped by category and action, each group with its
 * distinct values. Files keep the order in which they first appear.
 */
export function groupFileFindings(fileFindings: GovernanceFileFinding[] = []): FileFindings[] {
  const files = new Map<string, FileFindings>();
  for (const finding of fileFindings) {
    const { filename, fileId, type, category, label: displayName, action, count, terms } = finding;
    const id = JSON.stringify([fileId ?? null, filename]);
    let file = files.get(id);
    if (!file) {
      file = { id, filename, type, groups: [] };
      files.set(id, file);
    }
    file.groups.push({
      category,
      label: displayName,
      action,
      count,
      terms: terms && uniqueTerms(category, terms),
    });
  }
  return Array.from(files.values());
}

/**
 * A finding badge whose popup shows what was found. Hovering opens the popup until the pointer
 * leaves; a click, tap or Enter keeps it open until Escape or a click outside. The popup stays
 * inside the dialog and never takes focus: the dialog's Radix copy has its own layer and focus
 * stacks, and it ignores Escape only while an expanded trigger has focus.
 */
function FindingBadge({
  label,
  className,
  onHover,
  children,
}: {
  label: string;
  className: string;
  onHover: (hovered: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  /** The popup was opened by hovering, so it closes when the pointer leaves it. */
  const [byHover, setByHover] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  useEffect(() => cancelClose, [cancelClose]);

  const show = () => {
    cancelClose();
    if (!open) {
      setByHover(true);
      setOpen(true);
    }
  };
  const scheduleClose = () => {
    cancelClose();
    if (open && byHover) {
      closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
    }
  };
  const keepFocus = (event: Event) => event.preventDefault();

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        cancelClose();
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            BADGE,
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy',
            className,
          )}
          onMouseEnter={() => {
            show();
            onHover(true);
          }}
          onMouseLeave={() => {
            scheduleClose();
            onHover(false);
          }}
          onClick={(event) => {
            event.preventDefault();
            cancelClose();
            setByHover(false);
            setOpen(byHover || !open);
          }}
        >
          {label}
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Content
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        aria-label={label}
        onOpenAutoFocus={keepFocus}
        onCloseAutoFocus={keepFocus}
        onEscapeKeyDown={() => setOpen(false)}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        className="z-10 max-h-60 w-max max-w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border-light bg-surface-secondary p-2 text-sm text-text-primary shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
      >
        {children}
      </Popover.Content>
    </Popover.Root>
  );
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
  /** Keys of the values under the pointer, highlighted wherever they occur. */
  const [active, setActive] = useState<string[]>([]);
  const activeKeys = useMemo(() => new Set(active), [active]);
  const cancelRef = useRef<HTMLButtonElement>(null);
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
  const findingLabel = (finding: CategorizedFinding & Pick<GovernanceFinding, 'action'>) =>
    `${categoryLabel(finding)} · ${localize(DECISION_COPY[finding.action])}`;
  const findingTitle = (finding: GovernanceFinding) =>
    `${findingLabel(finding)}${finding.replacement ? ` → ${finding.replacement}` : ''}`;

  const findings = useMemo(
    () => keyFindings(originalText, result.findings),
    [originalText, result.findings],
  );
  const originalSegments = useMemo(
    () => buildFindingSegments(originalText, findings),
    [originalText, findings],
  );
  const files = useMemo(() => groupFileFindings(result.fileFindings), [result.fileFindings]);
  const maskedText = result.maskedPreview?.find(
    (m) => m.location === GOVERNANCE_DLP_TEXT_LOCATION,
  )?.text;
  const showMasked = decision === 'MASK' && Boolean(maskedText) && result.findings.length > 0;
  const maskedSegments = useMemo((): MaskedSegment<KeyedFinding>[] => {
    if (!showMasked || maskedText === undefined) {
      return [];
    }
    const segments = buildMaskedSegments(originalText, findings);
    const matches = segments.map(({ text }) => text).join('') === maskedText;
    return matches ? segments : [{ text: maskedText, findings: [] }];
  }, [showMasked, maskedText, originalText, findings]);

  const keysOf = (keyed: KeyedFinding[]) =>
    keyed.flatMap(({ key }) => (key === undefined ? [] : [key]));
  const litOf = (keyed: KeyedFinding[]) =>
    keyed.filter(({ key }) => key !== undefined && activeKeys.has(key));
  const hoverProps = (keys: string[]) =>
    keys.length === 0
      ? {}
      : { onMouseEnter: () => setActive(keys), onMouseLeave: () => setActive([]) };

  const renderOriginal = (segment: TextSegment<KeyedFinding>, index: number) => {
    if (!segment.findings) {
      return <span key={index}>{segment.text}</span>;
    }
    const covering = segment.findings.map(({ finding }) => finding);
    const lit = litOf(covering);
    return (
      <span key={index} {...hoverProps(keysOf(covering))}>
        {segment.findings.reduce<ReactNode>(
          (content, { finding, lane }) => (
            <span
              className={cn('border-b-2', ACTION_STYLE[finding.action].underline)}
              style={{ paddingBottom: 1 + lane * 4 }}
            >
              {content}
            </span>
          ),
          <mark
            title={covering.map(findingTitle).join('\n')}
            className={cn(
              'rounded-sm box-decoration-clone text-inherit transition-colors',
              lit.length > 0 ? ACTION_STYLE[mostSevere(lit)].highlight : 'bg-transparent',
            )}
          >
            {segment.text}
            {segment.findings.map(({ finding, ends }, i) =>
              ends ? (
                <span key={i} className="sr-only">
                  {` (${findingLabel(finding)})`}
                </span>
              ) : null,
            )}
          </mark>,
        )}
      </span>
    );
  };

  const renderMasked = (
    { text, findings: covering, replaced }: MaskedSegment<KeyedFinding>,
    index: number,
  ) => {
    if (!replaced && covering.length === 0) {
      return <span key={index}>{text}</span>;
    }
    const lit = litOf(covering);
    return (
      <span
        key={index}
        {...hoverProps(keysOf(covering))}
        className={cn(
          'rounded-sm box-decoration-clone transition-colors',
          replaced && ['font-semibold', ACTION_STYLE[replaced.action].ink],
          lit.length > 0 && ACTION_STYLE[mostSevere(lit)].highlight,
        )}
      >
        {text}
      </span>
    );
  };

  /** A badge per finding group; while one of its values is hovered anywhere, it lights up too. */
  const renderGroup = ({ category, label: displayName, action, count, terms }: FindingGroup) => {
    const id = `${category}\n${action}`;
    const caption = findingLabel({ category, label: displayName, action });
    const listed = terms ?? [];
    if (listed.length === 0) {
      return (
        <span key={id} className={cn(BADGE, ACTION_STYLE[action].chip)}>
          {caption}
          {terms === undefined && count > 1 ? ` × ${count}` : ''}
        </span>
      );
    }
    const keys = listed.map((term) => termKey(category, term));
    const hidden = listed.length - VISIBLE_TERMS;
    return (
      <FindingBadge
        key={id}
        label={caption}
        className={cn(
          ACTION_STYLE[action].chip,
          keys.some((key) => activeKeys.has(key)) && ACTION_STYLE[action].highlight,
        )}
        onHover={(hovered) => setActive(hovered ? keys : [])}
      >
        <ul className="flex flex-col gap-0.5">
          {listed.slice(0, VISIBLE_TERMS).map((term, i) => (
            <li key={keys[i]} {...hoverProps([keys[i]])} className="break-words">
              <span
                className={cn(
                  'rounded-sm box-decoration-clone px-1 transition-colors',
                  activeKeys.has(keys[i]) && ACTION_STYLE[action].highlight,
                )}
              >
                {term}
              </span>
            </li>
          ))}
          {hidden > 0 && (
            <li className="px-1 text-xs text-text-secondary">
              {localize('com_ui_dlp_more_terms', { 0: String(hidden) })}
            </li>
          )}
        </ul>
      </FindingBadge>
    );
  };

  /**
   * Every file in a review was sent as extracted text, which its source badge shows. A card grows
   * to fit its badges two to a row from the `sm` breakpoint, and its filename never widens it.
   */
  const renderFile = ({ id, filename, type, groups }: FileFindings) => {
    const fileType = getFileType(type);
    return (
      <li
        key={id}
        className="w-full min-w-0 overflow-hidden rounded-2xl border border-border-light bg-surface-hover-alt text-sm text-text-primary sm:w-auto sm:min-w-56 sm:max-w-full"
      >
        <div className="flex flex-row items-center gap-2 p-1.5">
          <FilePreview
            file={{ filename, type, source: FileSources.text }}
            fileType={fileType}
            className="relative"
          />
          <div className="w-0 flex-1">
            <div className="w-fit max-w-full overflow-hidden text-center">
              <h3 className="truncate font-medium" title={filename}>
                {filename}
              </h3>
              <div className="truncate text-text-secondary" title={fileType.title}>
                {fileType.title}
              </div>
            </div>
          </div>
        </div>
        <div
          className={cn(
            'grid justify-items-start gap-1.5 px-2.5 pb-3 pt-1',
            groups.length > 1 && 'sm:grid-cols-[repeat(2,minmax(0,auto))]',
          )}
        >
          {groups.map(renderGroup)}
        </div>
      </li>
    );
  };

  return (
    <OGDialog open onOpenChange={(open) => !open && onCancel()}>
      <OGDialogTemplate
        title={localize(COPY[decision].title)}
        description={localize(COPY[decision].description)}
        className="max-w-[760px]"
        headerClassName="[&_h2]:text-[28px] [&_h2]:leading-[1.14] [&_p]:text-sm [&_p]:tracking-[-0.016em]"
        showCancelButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        main={
          <div className="flex max-h-[65vh] flex-col gap-5 overflow-y-auto px-1" role="document">
            {sendFailed && (
              <p
                role="alert"
                className="rounded-xl border border-aimo-block bg-aimo-block-soft px-4 py-3 text-sm text-aimo-block-ink"
              >
                {localize('com_ui_dlp_send_failed')}
              </p>
            )}

            {files.length > 0 && (
              <section aria-label={localize('com_ui_dlp_file_findings')}>
                <ul className="flex flex-wrap gap-2">{files.map(renderFile)}</ul>
              </section>
            )}

            <section aria-label={localize('com_ui_dlp_original_prompt')}>
              <p className={PROMPT_BOX}>{originalSegments.map(renderOriginal)}</p>
            </section>

            {maskedSegments.length > 0 && (
              <section aria-label={localize('com_ui_dlp_masked_prompt')}>
                <p className={PROMPT_BOX}>{maskedSegments.map(renderMasked)}</p>
              </section>
            )}
          </div>
        }
        buttons={
          <>
            <Button ref={cancelRef} variant="outline" onClick={onCancel}>
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
