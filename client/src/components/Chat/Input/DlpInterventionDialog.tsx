import { useId, useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { Trans } from 'react-i18next';
import {
  Ban,
  Eye,
  Tag,
  Mail,
  User,
  Phone,
  EyeOff,
  Pencil,
  Paperclip,
  Contact,
  Receipt,
  Landmark,
  CreditCard,
  CircleCheck,
  ChevronDown,
  Fingerprint,
  ShieldAlert,
  TriangleAlert,
  MessageSquareText,
} from 'lucide-react';
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
import type { KeyboardEvent, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { CategorizedFinding } from './labels';
import type { TranslationKeys } from '~/hooks';
import { FLAGGED, MASKED_VALUE, useCategoryLabel } from './labels';
import FilePreview from './Files/FilePreview';
import { cn, getFileType } from '~/utils';
import { useLocalize } from '~/hooks';

/** An original value in the prompt, with the finding that took it. */
type FoundValue = { text: string; finding: GovernanceFinding; overlap: boolean };
/** The prompt: text without findings, and found values. */
type PromptSegment = { text: string } | FoundValue;
/** The findings of one category and action in one place, with the distinct values they matched. */
type FindingGroup = Pick<
  GovernanceFileFinding,
  'category' | 'label' | 'action' | 'count' | 'terms' | 'replacement'
>;
/** The findings in one place, the prompt or an attached file, whose MIME type picks its icon. */
type FileFindings = { id: string; filename: string; type?: string; groups: FindingGroup[] };
type ActionStyle = {
  chip: string;
  highlight: string;
  /** The highlight where findings overlap. */
  overlap: string;
  ink: string;
  icon: LucideIcon;
};

/** How many distinct matched values a finding badge lists before expanding. */
const VISIBLE_TERMS = 10;
/** Grace period so moving the pointer from a badge to its popup doesn't close it. */
const CLOSE_DELAY_MS = 120;
const SEVERITY: GovernanceDecision[] = ['ALLOW', 'WARN', 'MASK', 'BLOCK'];

const DECISION_COPY: Record<GovernanceDecision, TranslationKeys> = {
  ALLOW: 'com_ui_dlp_decision_allow',
  BLOCK: 'com_ui_dlp_decision_block',
  MASK: 'com_ui_dlp_decision_mask',
  WARN: 'com_ui_dlp_decision_warn',
};

const OUTCOME_COPY: Record<GovernanceDecision, TranslationKeys> = {
  ALLOW: 'com_ui_dlp_outcome_allow',
  BLOCK: 'com_ui_dlp_outcome_block',
  MASK: 'com_ui_dlp_outcome_mask',
  WARN: 'com_ui_dlp_outcome_warn',
};

/** The icon of a category's badge; any other category, such as a custom one, gets a tag. */
const CATEGORY_ICON: Record<string, LucideIcon | undefined> = {
  EMAIL_ADDRESS: Mail,
  PHONE_NUMBER: Phone,
  PERSON: User,
  IBAN_CODE: Landmark,
  CREDIT_CARD: CreditCard,
  DE_SOCIAL_SECURITY_NUMBER: Fingerprint,
  GERMAN_TAX_ID: Receipt,
  VAT_ID: Receipt,
  GERMAN_ID_CARD: Contact,
  GERMAN_PASSPORT: Contact,
};

const DLP_COPY = {
  title: 'com_ui_dlp_title',
  description: 'com_ui_dlp_description',
} as const;

const MODEL_BLOCK_COPY = {
  title: 'com_ui_dlp_model_blocked_title',
  description: 'com_ui_dlp_model_blocked_description',
} as const;

/** The box that holds the prompt and its findings. */
const PROMPT_BOX = 'flex flex-col gap-3 rounded-xl bg-aimo-fill px-4 py-3 dark:bg-aimo-ink-3';
/** The prompt scrolls inside its own box, so its findings below stay in view. */
const PROMPT_TEXT =
  'max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-aimo-line px-3 py-2 [overflow-wrap:anywhere] text-[17px] leading-8 text-text-primary';
const CARD =
  'flex flex-col gap-3 rounded-2xl border border-border-light bg-surface-hover-alt px-2 pb-3 pt-2 text-sm text-text-primary';
const HEADING = 'flex items-center gap-2 text-base font-semibold text-text-primary';
const BADGE =
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold tracking-[-0.01em] transition-colors';

const ACTION_STYLE: Record<GovernanceDecision, ActionStyle> = {
  ALLOW: {
    chip: 'border-aimo-green bg-aimo-green-soft text-aimo-green-ink',
    highlight: 'bg-aimo-green/30',
    overlap: 'bg-aimo-green/55',
    ink: 'text-aimo-green-ink',
    icon: CircleCheck,
  },
  MASK: {
    chip: 'border-aimo-mask bg-aimo-mask-soft text-aimo-mask-ink',
    highlight: 'bg-aimo-mask/35',
    overlap: 'bg-aimo-mask/65',
    ink: 'text-aimo-mask-ink',
    icon: EyeOff,
  },
  WARN: {
    chip: 'border-aimo-warn/50 bg-aimo-warn-soft text-aimo-warn-ink dark:bg-aimo-warn/10 dark:text-aimo-warn/80',
    highlight: 'bg-aimo-warn/20',
    overlap: 'bg-aimo-warn/40',
    ink: 'text-aimo-warn-ink dark:text-aimo-warn/80',
    icon: TriangleAlert,
  },
  BLOCK: {
    chip: 'border-aimo-block bg-aimo-block-soft text-aimo-block-ink',
    highlight: 'bg-aimo-block/30',
    overlap: 'bg-aimo-block/55',
    ink: 'text-aimo-block-ink',
    icon: Ban,
  },
};

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
 * replaced, more severe or earlier finding took. Where findings overlap, a value is split off
 * and marked as an overlap.
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
  const covered = new Uint16Array(chars.length);
  const kept: GovernanceFinding[] = [];
  for (const finding of findings) {
    if (!isInText(chars, finding)) {
      continue;
    }
    for (let i = finding.start; i < Math.min(finding.end, chars.length); i++) {
      covered[i]++;
    }
    if (finding.replacement === undefined) {
      kept.push(finding);
    }
  }
  kept.sort(bySeverity);
  for (const finding of kept) {
    for (let i = finding.start; i < Math.min(finding.end, chars.length); i++) {
      owners[i] ??= finding;
    }
  }

  const segments: PromptSegment[] = [];
  let from = 0;
  for (let i = 1; i <= chars.length; i++) {
    const overlap = covered[from] > 1;
    if (i < chars.length && owners[i] === owners[from] && covered[i] > 1 === overlap) {
      continue;
    }
    const segment = chars.slice(from, i).join('');
    const finding = owners[from];
    segments.push(finding ? { text: segment, finding, overlap } : { text: segment });
    from = i;
  }
  return segments;
}

/**
 * The findings in each place, grouped by category and action, each group with its distinct
 * values. Places keep the order in which they first appear.
 */
export function groupFindings(findings: GovernanceFileFinding[] = []): FileFindings[] {
  const files = new Map<string, FileFindings>();
  for (const { filename, fileId, type, count, terms, ...finding } of findings) {
    const id = JSON.stringify([fileId ?? null, filename]);
    let file = files.get(id);
    if (!file) {
      file = { id, filename, type, groups: [] };
      files.set(id, file);
    }
    const group = file.groups.find(
      ({ category, action }) => category === finding.category && action === finding.action,
    );
    if (!group) {
      file.groups.push({ ...finding, count, terms });
      continue;
    }
    group.count += count;
    group.terms = [...new Set([...(group.terms ?? []), ...(terms ?? [])])];
  }
  return Array.from(files.values());
}

/** The prompt's findings in the form of a file's, so the prompt gets a card like a file. */
function toPromptFindings(text: string, findings: GovernanceFinding[]): GovernanceFileFinding[] {
  const chars = Array.from(text);
  return findings
    .filter((finding) => isInText(chars, finding))
    .map(({ category, label, action, replacement, start, end }) => ({
      filename: '',
      category,
      label,
      action,
      replacement,
      count: 1,
      terms: [chars.slice(start, end).join('')],
    }));
}

/**
 * A finding badge whose popup shows what was found. Hovering opens the popup until the pointer
 * leaves; a click, tap, focus or expansion keeps it open until Escape or a click outside.
 * Hovering leaves focus in place; keyboard users can tab to the expansion button.
 */
function FindingBadge({
  label,
  icon,
  className,
  terms,
}: {
  label: string;
  icon: ReactNode;
  className: string;
  terms: string[];
}) {
  const localize = useLocalize();
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const container = triggerRef.current?.closest<HTMLDivElement>('[role="dialog"]') ?? null;
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
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

  const close = useCallback(
    (restoreFocus = false) => {
      cancelClose();
      setOpen(false);
      setExpanded(false);
      setByHover(false);
      if (restoreFocus) {
        triggerRef.current?.focus();
      }
    },
    [cancelClose],
  );

  /** The surrounding dialog and popover use separate Radix Escape listeners. */
  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-dlp-finding]') &&
        !triggerRef.current?.contains(target) &&
        !contentRef.current?.contains(target)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [open, close]);

  const pin = () => {
    cancelClose();
    setByHover(false);
  };
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
      closeTimer.current = setTimeout(() => close(), CLOSE_DELAY_MS);
    }
  };
  const keepFocus = (event: Event) => event.preventDefault();
  const leavePopup = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Tab' || !container) {
      return;
    }
    const controls = Array.from(
      container.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'),
    ).filter((element) => !contentRef.current?.contains(element));
    const triggerIndex = controls.findIndex((element) => element === triggerRef.current);
    const next = event.shiftKey ? triggerRef.current : (controls[triggerIndex + 1] ?? controls[0]);
    if (next) {
      event.preventDefault();
      event.stopPropagation();
      next.focus();
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setOpen(true);
        } else {
          close();
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          data-dlp-finding
          type="button"
          className={cn(
            BADGE,
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy',
            className,
          )}
          onMouseEnter={show}
          onMouseLeave={scheduleClose}
          onKeyDown={(event) => {
            if (open && event.key === 'Tab' && !event.shiftKey) {
              const toggle = contentRef.current?.querySelector('button');
              if (toggle) {
                event.preventDefault();
                event.stopPropagation();
                toggle.focus();
              }
            }
          }}
          onClick={(event) => {
            event.preventDefault();
            if (byHover || !open) {
              pin();
              setOpen(true);
            } else {
              close();
            }
          }}
        >
          {icon}
          {label}
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content
          ref={contentRef}
          data-dlp-finding
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          aria-label={label}
          onOpenAutoFocus={keepFocus}
          onCloseAutoFocus={keepFocus}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            close(true);
          }}
          onFocusCapture={pin}
          onPointerDown={pin}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          className="z-10 flex max-h-[min(20rem,var(--radix-popover-content-available-height,20rem))] w-max max-w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border-light bg-surface-secondary p-2 text-sm text-text-primary shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <ul
            id={listId}
            className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain"
          >
            {(expanded ? terms : terms.slice(0, VISIBLE_TERMS)).map((term) => (
              <li key={term} className="break-words px-1">
                {term}
              </li>
            ))}
          </ul>
          {terms.length > VISIBLE_TERMS && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={listId}
              className="mt-1 shrink-0 rounded px-1 py-1 text-left text-xs font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy"
              onKeyDown={leavePopup}
              onClick={() => {
                pin();
                setExpanded((current) => !current);
              }}
            >
              {expanded
                ? localize('com_ui_dlp_show_fewer_terms')
                : localize('com_ui_dlp_show_all_terms', {
                    0: String(terms.length - VISIBLE_TERMS),
                  })}
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
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
  const { decision, modelNotAllowed, modelRestriction } = result;
  const copy = modelNotAllowed ? MODEL_BLOCK_COPY : DLP_COPY;
  const title = localize(modelRestriction ? 'com_ui_dlp_model_restricted_title' : copy.title);
  /** The restriction names the models in the text, which the dialog's plain description cannot. */
  const description = modelRestriction
    ? undefined
    : localize(copy.description, modelNotAllowed && { 0: modelNotAllowed.model });
  /** The dialog opens on the values as the model will receive them. */
  const [showMasked, setShowMasked] = useState(true);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const categoryLabel = useCategoryLabel();
  const findingLabel = (finding: CategorizedFinding & Pick<GovernanceFinding, 'action'>) =>
    `${categoryLabel(finding)} · ${localize(DECISION_COPY[finding.action])}`;

  const files = useMemo(() => groupFindings(result.fileFindings), [result.fileFindings]);
  /** The prompt's findings, grouped like a file's. */
  const promptGroups = useMemo(
    () => groupFindings(toPromptFindings(originalText, result.findings))[0]?.groups ?? [],
    [originalText, result.findings],
  );
  /** The prompt with its findings, each value the gateway replaces where the review puts it. */
  const promptSegments = useMemo(
    () => buildPromptSegments(originalText, result.findings, result.maskedRanges),
    [originalText, result.findings, result.maskedRanges],
  );
  /** The distinct actions of the findings, least severe first, which the gateway combined. */
  const actions = useMemo(
    () =>
      SEVERITY.filter(
        (action) =>
          promptGroups.some((group) => group.action === action) ||
          files.some(({ groups }) => groups.some((group) => group.action === action)),
      ),
    [promptGroups, files],
  );
  const categoryCount = new Set([
    ...promptGroups.map(({ category }) => category),
    ...files.flatMap(({ groups }) => groups.map(({ category }) => category)),
  ]).size;
  const DecisionIcon = ACTION_STYLE[decision].icon;
  /** Whether the gateway replaces a value in the prompt; badges always list the originals. */
  const hasMasked = promptSegments.some(
    (segment) => 'finding' in segment && segment.finding.replacement !== undefined,
  );
  const masked = hasMasked && showMasked;
  const toggleLabel = localize(masked ? 'com_ui_dlp_show_original' : 'com_ui_dlp_show_masked');

  /**
   * Enter sends, unless another control has focus, which keeps its own action. A held Enter never
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

  /**
   * A detected value shows as entered, more strongly where findings overlap. In the masked view a
   * value the gateway replaces shows its replacement once, across the parts an overlap split it in.
   */
  const renderSegment = (segment: PromptSegment, index: number) => {
    if (!('finding' in segment)) {
      return <span key={index}>{segment.text}</span>;
    }
    const { text, finding, overlap } = segment;
    const replaced = masked && finding.replacement !== undefined;
    const previous = promptSegments[index - 1];
    if (replaced && previous && 'finding' in previous && previous.finding === finding) {
      return null;
    }
    const style = ACTION_STYLE[finding.action];
    return (
      <mark
        key={index}
        title={categoryLabel(finding)}
        className={replaced ? MASKED_VALUE : cn(FLAGGED, overlap ? style.overlap : style.highlight)}
      >
        {replaced ? finding.replacement : text}
        <span className="sr-only">{` (${findingLabel(finding)})`}</span>
      </mark>
    );
  };

  /**
   * A badge per finding group, whose popup lists its original values, whichever view the
   * prompt shows.
   */
  const renderGroup = ({ category, label: displayName, action, count, terms }: FindingGroup) => {
    const id = `${category}\n${action}`;
    const caption = findingLabel({ category, label: displayName, action });
    const listed = terms ?? [];
    const Icon = CATEGORY_ICON[category] ?? Tag;
    const icon = <Icon className="size-3.5 shrink-0" aria-hidden="true" />;
    if (listed.length === 0) {
      return (
        <span key={id} className={cn(BADGE, ACTION_STYLE[action].chip)}>
          {icon}
          {caption}
          {count > 1 ? ` × ${count}` : ''}
        </span>
      );
    }
    return (
      <FindingBadge
        key={id}
        label={caption}
        icon={icon}
        className={ACTION_STYLE[action].chip}
        terms={listed}
      />
    );
  };

  /** A file's card header: its preview, name and type, like in the composer. */
  const fileHeader = (filename: string, type?: string): ReactNode => {
    const fileType = getFileType(type);
    return (
      <>
        <FilePreview
          file={{ filename, type, source: FileSources.text }}
          fileType={fileType}
          className="relative"
        />
        <div className="w-0 flex-1">
          <div className="overflow-hidden">
            <h3 className="truncate font-medium" title={filename}>
              {filename}
            </h3>
            <div className="truncate text-text-secondary" title={fileType.title}>
              {fileType.title}
            </div>
          </div>
        </div>
      </>
    );
  };

  /** A full-width card per attached file with findings: the file, then its badges under it. */
  const renderFile = ({ id, filename, type, groups }: FileFindings) => (
    <li key={id} className={CARD}>
      <div className="flex min-w-0 items-center gap-2">{fileHeader(filename, type)}</div>
      <div className="flex flex-wrap items-center gap-1.5 px-1">{groups.map(renderGroup)}</div>
    </li>
  );

  return (
    <OGDialog open onOpenChange={(open) => !open && onCancel()}>
      <OGDialogTemplate
        title={title}
        description={description}
        icon={
          <ShieldAlert
            className={cn('mt-1 size-9 shrink-0', ACTION_STYLE[decision].ink)}
            aria-hidden="true"
          />
        }
        showCloseButton
        className="max-w-[760px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-visible"
        mainClassName="flex min-h-0 overflow-hidden"
        headerClassName="[&_h2]:text-[28px] [&_h2]:leading-[1.14] [&_p]:text-sm [&_p]:tracking-[-0.016em]"
        showCancelButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (confirmRef.current ?? cancelRef.current)?.focus();
        }}
        onKeyDown={sendOnEnter}
        main={
          <div
            className="flex max-h-[65vh] min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1"
            role="document"
          >
            {modelRestriction && (
              <p className="text-sm tracking-[-0.016em] text-text-secondary">
                <Trans
                  i18nKey="com_ui_dlp_model_restricted_description"
                  values={{
                    models: modelRestriction.models.join(', '),
                    categories: modelRestriction.categories
                      .map((category) => categoryLabel({ category }))
                      .join(', '),
                  }}
                  components={{
                    model: <span className={cn(BADGE, 'px-2 py-0.5', ACTION_STYLE.BLOCK.chip)} />,
                  }}
                />
              </p>
            )}
            {sendFailed && (
              <p
                role="alert"
                className="rounded-xl border border-aimo-block bg-aimo-block-soft px-4 py-3 text-sm text-aimo-block-ink"
              >
                {localize('com_ui_dlp_send_failed')}
              </p>
            )}

            {modelNotAllowed && (
              <section
                aria-label={localize('com_ui_dlp_allowed_tiers')}
                className="flex flex-col gap-2 text-sm text-text-primary"
              >
                {modelNotAllowed.allowedTiers.length > 0 ? (
                  <>
                    <p>{localize('com_ui_dlp_model_blocked_tiers')}</p>
                    <ul className="flex flex-col gap-1">
                      {modelNotAllowed.allowedTiers.map(({ code, name, description }) => (
                        <li key={code}>
                          <span className="font-semibold">{name}</span>
                          <span className="text-text-secondary">{` · ${description}`}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>{localize('com_ui_dlp_model_blocked_no_tier')}</p>
                )}
              </section>
            )}

            {!modelNotAllowed && decision === 'BLOCK' && (
              <section
                aria-label={localize('com_ui_dlp_overall_action')}
                className={cn(
                  'flex items-center gap-4 rounded-xl border px-4 py-3',
                  ACTION_STYLE[decision].chip,
                )}
              >
                <DecisionIcon className="size-7 shrink-0" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
                    <span>{`${localize('com_ui_dlp_overall_action')}:`}</span>
                    <span className="text-base">{localize(DECISION_COPY[decision])}</span>
                    {actions.length > 1 && (
                      <span className="font-normal">
                        {`(${actions
                          .map((action) => localize(DECISION_COPY[action]))
                          .join(' + ')} → ${localize(DECISION_COPY[decision])})`}
                      </span>
                    )}
                  </p>
                  <p className="text-sm">{localize(OUTCOME_COPY[decision])}</p>
                </div>
              </section>
            )}

            {files.length > 0 && (
              <section
                aria-label={localize('com_ui_dlp_attachments')}
                className="flex flex-col gap-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <h3 className={HEADING}>
                    <Paperclip className="size-5" aria-hidden="true" />
                    {localize('com_ui_dlp_attachments')}
                  </h3>
                  <p className="text-sm text-text-secondary">
                    {`${localize(files.length === 1 ? 'com_ui_dlp_one_file' : 'com_ui_dlp_files', {
                      0: String(files.length),
                    })} · ${localize(
                      categoryCount === 1 ? 'com_ui_dlp_one_data_type' : 'com_ui_dlp_data_types',
                      { 0: String(categoryCount) },
                    )}`}
                  </p>
                </div>
                <ul className="flex flex-col gap-2">{files.map(renderFile)}</ul>
              </section>
            )}

            {(!modelNotAllowed || result.findings.length > 0) && (
              <div
                className={cn(
                  'flex flex-col gap-3',
                  files.length > 0 && 'border-t border-border-light pt-5',
                )}
              >
                <div className="flex items-center justify-between gap-4">
                  <h3 className={HEADING}>
                    <MessageSquareText className="size-5" aria-hidden="true" />
                    {localize('com_ui_dlp_your_prompt')}
                  </h3>
                  {hasMasked && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title={toggleLabel}
                      aria-label={toggleLabel}
                      onClick={() => setShowMasked((current) => !current)}
                    >
                      {masked ? (
                        <Eye className="size-5" aria-hidden="true" />
                      ) : (
                        <EyeOff className="size-5" aria-hidden="true" />
                      )}
                    </Button>
                  )}
                </div>
                <section
                  className={PROMPT_BOX}
                  aria-label={localize(
                    masked ? 'com_ui_dlp_masked_prompt' : 'com_ui_dlp_original_prompt',
                  )}
                >
                  <p className={PROMPT_TEXT}>{promptSegments.map(renderSegment)}</p>
                  {promptGroups.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">{promptGroups.map(renderGroup)}</div>
                  )}
                </section>
              </div>
            )}
          </div>
        }
        buttons={
          <>
            <Button ref={cancelRef} variant="outline" onClick={onCancel}>
              {localize(decision === 'BLOCK' ? 'com_ui_close' : 'com_ui_cancel')}
            </Button>
            {decision === 'BLOCK' && !modelNotAllowed && !modelRestriction && (
              <Button ref={confirmRef} variant="submit" onClick={onCancel}>
                <Pencil className="mr-2 size-4" aria-hidden="true" />
                {localize('com_ui_dlp_edit_prompt')}
              </Button>
            )}
            {decision !== 'BLOCK' && (
              <Button
                ref={confirmRef}
                variant={decision === 'MASK' ? 'submit' : 'default'}
                onClick={onConfirm}
              >
                {localize(
                  decision === 'MASK' ? 'com_ui_dlp_send_masked' : 'com_ui_dlp_send_anyway',
                )}
              </Button>
            )}
          </>
        }
      />
    </OGDialog>
  );
}
