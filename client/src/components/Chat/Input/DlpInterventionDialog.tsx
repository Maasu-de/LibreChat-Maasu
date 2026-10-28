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
import type { ReactNode, SyntheticEvent } from 'react';
import type { TranslationKeys } from '~/hooks';
import FilePreview from './Files/FilePreview';
import { cn, getFileType } from '~/utils';
import { useLocalize } from '~/hooks';

/** An original value in the prompt, set as a redaction bar for the finding that took it. */
type RedactedValue = { text: string; finding: GovernanceFinding };
/** The prompt: text without findings, and redacted values. */
type PromptSegment = { text: string } | RedactedValue;
/** The redacted value shown in the text, and the place its bar took before the text reflowed. */
type RevealedValue = { index: number; bar: DOMRect[]; element: HTMLElement };
/** The findings of one category and action in a file, with the distinct values they matched. */
type FindingGroup = Pick<
  GovernanceFileFinding,
  'category' | 'label' | 'action' | 'count' | 'terms'
>;
/** The findings in one attached file, whose MIME type picks its icon like in the composer. */
type FileFindings = { id: string; filename: string; type?: string; groups: FindingGroup[] };
type CategorizedFinding = Pick<GovernanceFinding, 'category' | 'label'>;
type ActionStyle = { chip: string; highlight: string };

/** How many matched values the popup of a finding badge lists; the rest are only counted. */
const VISIBLE_TERMS = 50;
/** Grace period so moving the pointer from a badge to its popup doesn't close it. */
const CLOSE_DELAY_MS = 120;

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

/** The box that holds the prompt, as it will be sent when the gateway masks it. */
const PROMPT_BOX =
  'whitespace-pre-wrap rounded-xl bg-aimo-fill [overflow-wrap:anywhere] px-4 py-3 text-[17px] leading-8 text-text-primary dark:bg-aimo-ink-3';
/**
 * A finding in the prompt, set in ink like a redaction bar. The bar never breaks across lines,
 * so a revealed value no wider than it takes exactly its place.
 */
const REDACTION =
  'inline-grid max-w-full justify-items-center rounded-sm px-1 py-0.5 leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy';
const REDACTED = 'bg-text-primary text-surface-primary';
const BADGE =
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold tracking-[-0.01em] transition-colors';

const ACTION_STYLE: Record<GovernanceDecision, ActionStyle> = {
  ALLOW: {
    chip: 'border-aimo-green bg-aimo-green-soft text-aimo-green-ink',
    highlight: 'bg-aimo-green/25',
  },
  MASK: {
    chip: 'border-aimo-mask bg-aimo-mask-soft text-aimo-mask-ink',
    highlight: 'bg-aimo-mask/35',
  },
  WARN: {
    chip: 'border-aimo-warn bg-aimo-warn-soft text-aimo-warn-ink',
    highlight: 'bg-aimo-warn/25',
  },
  BLOCK: {
    chip: 'border-aimo-block bg-aimo-block-soft text-aimo-block-ink',
    highlight: 'bg-aimo-block/20',
  },
};

const isAt = (x: number, y: number) => (rect: DOMRect) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

const byPosition = (a: GovernanceFinding, b: GovernanceFinding) =>
  a.start - b.start || b.end - a.end;

const isInText = (chars: string[], f: GovernanceFinding) =>
  f.location === GOVERNANCE_DLP_TEXT_LOCATION &&
  f.start >= 0 &&
  f.end > f.start &&
  f.start < chars.length;

/** Names a value of a category, ignoring case and spacing, so a file lists it once. */
const termKey = (category: string, term: string): string =>
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

/**
 * Splits the text into what has no findings and a redacted value per finding, in text order. A
 * value the gateway replaces takes the range the gateway masks; any other finding takes what no
 * replaced or earlier finding took, so text that findings share is in one bar.
 */
export function buildRedactedSegments(
  text: string,
  findings: GovernanceFinding[],
): PromptSegment[] {
  const chars = Array.from(text);
  const inText = findings.filter((finding) => isInText(chars, finding));
  const owners = new Array<GovernanceFinding | undefined>(chars.length);
  for (const { start, end, finding } of getGovernanceMaskRanges(chars, inText)) {
    owners.fill(finding, start, end);
  }
  const kept = inText.filter(({ replacement }) => replacement === undefined).sort(byPosition);
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

/** The text the gateway sends for the segments: each replaced value as its replacement. */
export const sentText = (segments: PromptSegment[]): string =>
  segments
    .map((segment) =>
      'finding' in segment ? (segment.finding.replacement ?? segment.text) : segment.text,
    )
    .join('');

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

  const files = useMemo(() => groupFileFindings(result.fileFindings), [result.fileFindings]);
  const maskedText = result.maskedPreview?.find(
    (m) => m.location === GOVERNANCE_DLP_TEXT_LOCATION,
  )?.text;
  /** The prompt with every finding redacted; when it is masked, exactly as it will be sent. */
  const promptSegments = useMemo(() => {
    const segments = buildRedactedSegments(originalText, result.findings);
    const unlike =
      decision === 'MASK' && maskedText !== undefined && sentText(segments) !== maskedText;
    return unlike ? [{ text: maskedText }] : segments;
  }, [decision, maskedText, originalText, result.findings]);

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
   * A finding in the prompt is set like a redaction bar, with the gateway's replacement or, when
   * the value is not replaced, its category. While the pointer is on it, or it has focus, the
   * original value takes its place, centered on the bar's width when it is shorter, so the text
   * after it doesn't move. Only that bar lights up, never other bars.
   */
  const renderRedacted = ({ text, finding }: RedactedValue, index: number) => {
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
          {finding.replacement ?? `[${categoryLabel(finding)}]`}
        </span>
        {shown && <span className="[grid-area:1/1]">{text}</span>}
        <span className="sr-only">{` (${findingLabel(finding)})`}</span>
      </mark>
    );
  };

  const renderSegment = (segment: PromptSegment, index: number) =>
    'finding' in segment ? renderRedacted(segment, index) : <span key={index}>{segment.text}</span>;

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
