import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { Button, OGDialog, OGDialogTemplate } from '@librechat/client';
import { FileSources, GOVERNANCE_DLP_TEXT_LOCATION } from 'librechat-data-provider';
import type {
  GovernanceDlpResult,
  GovernanceFinding,
  GovernanceDecision,
  GovernanceMaskedRange,
  GovernanceFileFinding,
} from 'librechat-data-provider';
import type { ReactNode, KeyboardEvent, SyntheticEvent } from 'react';
import type { CategorizedFinding } from '~/components/Chat/Messages/Content/MaskedText';
import type { TranslationKeys } from '~/hooks';
import {
  REDACTED,
  REDACTION_BAR,
  useCategoryLabel,
} from '~/components/Chat/Messages/Content/MaskedText';
import FilePreview from './Files/FilePreview';
import { cn, getFileType } from '~/utils';
import { useLocalize } from '~/hooks';

/** An original value in the prompt, with the finding that took it. */
type FoundValue = { text: string; finding: GovernanceFinding };
/** The prompt: text without findings, and found values. */
type PromptSegment = { text: string } | FoundValue;
/** The redacted value shown in the text, and the place its bar took before the text reflowed. */
type RevealedValue = { index: number; bar: DOMRect[]; element: HTMLElement };
/** The findings of one category and action in a file, with the distinct values they matched. */
type FindingGroup = Pick<
  GovernanceFileFinding,
  'category' | 'label' | 'action' | 'count' | 'terms'
>;
/** The findings in one attached file, whose MIME type picks its icon like in the composer. */
type FileFindings = { id: string; filename: string; type?: string; groups: FindingGroup[] };
type ActionStyle = { chip: string; highlight: string };

/** How many matched values the popup of a finding badge lists; the rest are only counted. */
const VISIBLE_TERMS = 50;
/** Grace period so moving the pointer from a badge to its popup doesn't close it. */
const CLOSE_DELAY_MS = 120;
const SEVERITY: GovernanceDecision[] = ['ALLOW', 'WARN', 'MASK', 'BLOCK'];

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

/** The box that holds the prompt, as it will be sent when the gateway masks it. */
const PROMPT_BOX =
  'whitespace-pre-wrap rounded-xl bg-aimo-fill [overflow-wrap:anywhere] px-4 py-3 text-[17px] leading-8 text-text-primary dark:bg-aimo-ink-3';
/** A redaction bar the pointer or focus can reveal, unlike the bars of a sent message. */
const REDACTION = cn(
  REDACTION_BAR,
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy',
);
/** A value the gateway keeps, readable on the color of its finding's action. */
const FLAGGED = 'rounded-sm box-decoration-clone px-0.5 text-inherit';
const BADGE =
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold tracking-[-0.01em] transition-colors';

const ACTION_STYLE: Record<GovernanceDecision, ActionStyle> = {
  ALLOW: {
    chip: 'border-aimo-green bg-aimo-green-soft text-aimo-green-ink',
    highlight: 'bg-aimo-green/30',
  },
  MASK: {
    chip: 'border-aimo-mask bg-aimo-mask-soft text-aimo-mask-ink',
    highlight: 'bg-aimo-mask/35',
  },
  WARN: {
    chip: 'border-aimo-warn bg-aimo-warn-soft text-aimo-warn-ink',
    highlight: 'bg-aimo-warn/40',
  },
  BLOCK: {
    chip: 'border-aimo-block bg-aimo-block-soft text-aimo-block-ink',
    highlight: 'bg-aimo-block/30',
  },
};

const isAt = (x: number, y: number) => (rect: DOMRect) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

const byPosition = (a: GovernanceFinding, b: GovernanceFinding) =>
  a.start - b.start || b.end - a.end;

const bySeverity = (a: GovernanceFinding, b: GovernanceFinding) =>
  SEVERITY.indexOf(b.action) - SEVERITY.indexOf(a.action) || byPosition(a, b);

const isInText = (chars: string[], f: GovernanceFinding) =>
  f.location === GOVERNANCE_DLP_TEXT_LOCATION &&
  f.start >= 0 &&
  f.end > f.start &&
  f.start < chars.length;

/**
 * Splits the text into what has no findings and a value per finding, in text order. A value the
 * gateway replaces takes the range the review gives it; any other finding takes what no
 * replaced, more severe or earlier finding took.
 */
export function buildPromptSegments(
  text: string,
  findings: GovernanceFinding[],
  maskedRanges: GovernanceMaskedRange[] = [],
): PromptSegment[] {
  const chars = Array.from(text);
  const owners = new Array<GovernanceFinding | undefined>(chars.length);
  for (const { start, end, finding } of maskedRanges) {
    owners.fill(findings[finding], start, end);
  }
  const kept = findings
    .filter((finding) => finding.replacement === undefined && isInText(chars, finding))
    .sort(bySeverity);
  for (const finding of kept) {
    for (let i = finding.start; i < Math.min(finding.end, chars.length); i++) {
      owners[i] ??= finding;
    }
  }

  const segments: PromptSegment[] = [];
  let from = 0;
  for (let i = 1; i <= chars.length; i++) {
    if (i < chars.length && owners[i] === owners[from]) {
      continue;
    }
    const segment = chars.slice(from, i).join('');
    const finding = owners[from];
    segments.push(finding ? { text: segment, finding } : { text: segment });
    from = i;
  }
  return segments;
}

/**
 * The findings in each attached file, grouped by category and action, each group with its
 * distinct values. Files keep the order in which they first appear.
 */
export function groupFileFindings(fileFindings: GovernanceFileFinding[] = []): FileFindings[] {
  const files = new Map<string, FileFindings>();
  for (const { filename, fileId, type, category, label, action, count, terms } of fileFindings) {
    const id = JSON.stringify([fileId ?? null, filename]);
    let file = files.get(id);
    if (!file) {
      file = { id, filename, type, groups: [] };
      files.set(id, file);
    }
    file.groups.push({ category, label, action, count, terms });
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
  children,
}: {
  label: string;
  className: string;
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
          onMouseEnter={show}
          onMouseLeave={scheduleClose}
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
  const [revealed, setRevealed] = useState<RevealedValue | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const categoryLabel = useCategoryLabel();
  const findingLabel = (finding: CategorizedFinding & Pick<GovernanceFinding, 'action'>) =>
    `${categoryLabel(finding)} · ${localize(DECISION_COPY[finding.action])}`;

  const files = useMemo(() => groupFileFindings(result.fileFindings), [result.fileFindings]);
  /** The prompt with its findings, each value the gateway replaces where the review puts it. */
  const promptSegments = useMemo(
    () => buildPromptSegments(originalText, result.findings, result.maskedRanges),
    [originalText, result.findings, result.maskedRanges],
  );

  /** The text reflows around a revealed value, so it stays until the pointer leaves both places. */
  useEffect(() => {
    if (revealed === null) {
      return;
    }
    const { index, bar, element } = revealed;
    const conceal = ({ clientX, clientY }: MouseEvent) => {
      const at = isAt(clientX, clientY);
      if (bar.some(at) || Array.from(element.getClientRects()).some(at)) {
        return;
      }
      setRevealed((current) => (current?.index === index ? null : current));
    };
    document.addEventListener('mousemove', conceal);
    return () => document.removeEventListener('mousemove', conceal);
  }, [revealed]);

  /**
   * A value the gateway replaces is set like a redaction bar with its replacement. While the
   * pointer is on it, or it has focus, the original value takes its place, centered on the bar's
   * width when it is shorter, so the text after it doesn't move. Only that bar lights up.
   */
  const renderRedacted = ({ text, finding }: FoundValue, index: number) => {
    const shown = revealed?.index === index;
    const reveal = ({ currentTarget }: SyntheticEvent<HTMLElement>) => {
      const bar = Array.from(currentTarget.getClientRects());
      setRevealed((current) =>
        current?.index === index ? current : { index, bar, element: currentTarget },
      );
    };
    return (
      <mark
        key={index}
        tabIndex={0}
        onMouseEnter={reveal}
        onFocus={reveal}
        onBlur={() => setRevealed((current) => (current?.index === index ? null : current))}
        className={cn(
          REDACTION,
          shown ? [ACTION_STYLE[finding.action].highlight, 'text-inherit'] : REDACTED,
        )}
      >
        <span
          aria-hidden={shown || undefined}
          className={cn('font-semibold [grid-area:1/1]', shown && 'invisible')}
        >
          {finding.replacement}
        </span>
        {shown && <span className="[grid-area:1/1]">{text}</span>}
        <span className="sr-only">{` (${findingLabel(finding)})`}</span>
      </mark>
    );
  };

  /**
   * Enter sends, unless another button has focus, which keeps its own action. A held Enter never
   * does, so a key still down from the composer can't send a prompt nobody has seen.
   */
  const sendOnEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (decision === 'BLOCK' || event.key !== 'Enter') {
      return;
    }
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    if (event.target instanceof Element && event.target.closest('button')) {
      return;
    }
    event.preventDefault();
    onConfirm();
  };

  const renderFlagged = ({ text, finding }: FoundValue, index: number) => (
    <mark key={index} className={cn(FLAGGED, ACTION_STYLE[finding.action].highlight)}>
      {text}
      <span className="sr-only">{` (${findingLabel(finding)})`}</span>
    </mark>
  );

  const renderSegment = (segment: PromptSegment, index: number) => {
    if (!('finding' in segment)) {
      return <span key={index}>{segment.text}</span>;
    }
    return segment.finding.replacement === undefined
      ? renderFlagged(segment, index)
      : renderRedacted(segment, index);
  };

  /** A badge per finding group, whose popup only lists its values: nothing lights up with them. */
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
    const hidden = listed.length - VISIBLE_TERMS;
    return (
      <FindingBadge key={id} label={caption} className={ACTION_STYLE[action].chip}>
        <ul className="flex flex-col gap-0.5">
          {listed.slice(0, VISIBLE_TERMS).map((term) => (
            <li key={term} className="break-words px-1">
              {term}
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
          (confirmRef.current ?? cancelRef.current)?.focus();
        }}
        onKeyDown={sendOnEnter}
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

            <section
              aria-label={localize(
                decision === 'MASK' ? 'com_ui_dlp_masked_prompt' : 'com_ui_dlp_original_prompt',
              )}
            >
              <p className={PROMPT_BOX}>{promptSegments.map(renderSegment)}</p>
            </section>
          </div>
        }
        buttons={
          <>
            <Button ref={cancelRef} variant="outline" onClick={onCancel}>
              {localize(decision === 'BLOCK' ? 'com_ui_close' : 'com_ui_cancel')}
            </Button>
            {decision !== 'BLOCK' && (
              <Button
                ref={confirmRef}
                variant={decision === 'WARN' ? 'default' : 'submit'}
                onClick={onConfirm}
              >
                {localize(decision === 'MASK' ? 'com_ui_dlp_send_masked' : 'com_ui_dlp_continue')}
              </Button>
            )}
          </>
        }
      />
    </OGDialog>
  );
}
