import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';

const MASK = '[MASKED]';
const SENSITIVE_VALUE_PATTERN = new RegExp(
  [
    String.raw`\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']+?(?=[.,;!?](?:\s|$)|\s|$)`,
    String.raw`\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret)\s*[:=]\s*["']?[A-Z0-9._~+\/-]{8,}?(?=[,;!?](?:\s|$)|\s|$)`,
    String.raw`\b(?:sk-[A-Z0-9_-]{16,}|gh[pousr]_[A-Z0-9]{20,}|AIza[A-Z0-9_-]{20,})\b`,
    String.raw`\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`,
    String.raw`\b(?:\d[ -]*?){13,19}\b`,
    String.raw`(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,8}(?:[\s.-]\d{2,8})?\b`,
  ].join('|'),
  'gi',
);

export interface SensitiveValueResult {
  count: number;
  maskedText: string;
}

export function maskSensitiveValues(text: string): SensitiveValueResult {
  let count = 0;
  const maskedText = text.replace(SENSITIVE_VALUE_PATTERN, () => {
    count += 1;
    return MASK;
  });

  return { count, maskedText };
}

function getTextPart(part: TMessageContentParts): string | null {
  if (part.type !== ContentTypes.TEXT) {
    return null;
  }

  if (typeof part.text === 'string') {
    return part.text;
  }

  return part.text?.value ?? null;
}

function countMessageSensitiveValues(message: TMessage): number {
  if (message.isCreatedByUser !== true) {
    return 0;
  }

  if (!message.content?.length) {
    return maskSensitiveValues(message.text).count;
  }

  let count = 0;
  for (const part of message.content) {
    const text = getTextPart(part);
    if (text !== null) {
      count += maskSensitiveValues(text).count;
    }
  }

  return count;
}

export function countSensitiveValuesInMessages(messagesTree?: TMessage[] | null): number {
  let count = 0;
  let siblings = messagesTree;

  while (siblings?.length) {
    const message = siblings[siblings.length - 1];
    count += countMessageSensitiveValues(message);
    siblings = message.children;
  }

  return count;
}
