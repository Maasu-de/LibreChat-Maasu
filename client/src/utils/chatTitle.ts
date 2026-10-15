const CHAT_TITLE = 'AIMO · Chat';

export function formatChatTitle(pageTitle?: string | null): string {
  const subtitle = pageTitle?.trim();
  return subtitle ? `${CHAT_TITLE} · ${subtitle}` : CHAT_TITLE;
}
