import { memo, useCallback, lazy, Suspense } from 'react';
import { useRecoilValue } from 'recoil';
import { Home, MessagesSquare, Shield, SquarePen } from 'lucide-react';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { Skeleton, Button, TooltipAnchor } from '@librechat/client';
import type { NavLink } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import { useLocalize, useNewConvo } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';
import { clearMessagesCache, cn } from '~/utils';
import store from '~/store';

const AccountSettings = lazy(() => import('~/components/Nav/AccountSettings'));

const NewChatButton = memo(function NewChatButton({
  setActive,
}: {
  setActive: (id: string) => void;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { newConversation } = useNewConvo();
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const switchToHistory = useRecoilValue(store.newChatSwitchToHistory);
  const tooltipDescription = useShortcutHint('newChat', localize('com_ui_new_chat'));
  const ariaKey = useShortcutAriaKey('newChat');

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button === 0 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        clearMessagesCache(queryClient, conversation?.conversationId);
        queryClient.invalidateQueries([QueryKeys.messages]);
        newConversation();
        if (switchToHistory) {
          setActive(DEFAULT_PANEL);
        }
      }
    },
    [queryClient, conversation?.conversationId, newConversation, switchToHistory, setActive],
  );

  return (
    <TooltipAnchor
      side="right"
      description={tooltipDescription}
      render={
        <a
          href="/c/new"
          data-testid="new-chat-button"
          aria-label={localize('com_ui_new_chat')}
          aria-keyshortcuts={ariaKey}
          className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-surface-hover"
          onClick={handleClick}
        >
          <SquarePen className="h-5 w-5 text-text-primary" />
        </a>
      }
    />
  );
});

const NavIconButton = memo(function NavIconButton({
  link,
  isActive,
  expanded,
  setActive,
  onExpand,
  onCollapse,
}: {
  link: NavLink;
  isActive: boolean;
  expanded: boolean;
  setActive: (id: string) => void;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const localize = useLocalize();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (link.onClick) {
        link.onClick(e);
        return;
      }
      if (isActive && expanded) {
        onCollapse?.();
        return;
      }
      if (!isActive) {
        setActive(link.id);
      }
      if (!expanded) {
        onExpand?.();
      }
    },
    [link, isActive, setActive, expanded, onExpand, onCollapse],
  );

  return (
    <TooltipAnchor
      description={localize(link.title)}
      side="right"
      render={
        <Button
          size="icon"
          variant="ghost"
          aria-label={localize(link.title)}
          aria-pressed={isActive}
          data-testid={`nav-panel-${link.id}`}
          className={cn(
            'h-9 w-9 rounded-lg',
            isActive ? 'bg-surface-active-alt text-text-primary' : 'text-text-secondary',
          )}
          onClick={handleClick}
        >
          <link.icon className="h-5 w-5" aria-hidden="true" />
        </Button>
      }
    />
  );
});

function ExpandedPanel({
  links,
  expanded = true,
  onCollapse,
  onExpand,
}: {
  links: NavLink[];
  expanded?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
}) {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const { active, setActive } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);

  return (
    <div className="flex h-full w-16 flex-shrink-0 flex-col gap-2 border-r border-border-light bg-surface-primary-alt px-[13.5px] py-2">
      <NewChatButton setActive={setActive} />
      <div className="mx-2 border-b border-border-light" />
      <div className="flex flex-col gap-1 overflow-y-auto">
        {links.map((link) => (
          <NavIconButton
            key={link.id}
            link={link}
            isActive={link.id === effectiveActive}
            expanded={expanded ?? true}
            setActive={setActive}
            onExpand={onExpand}
            onCollapse={onCollapse}
          />
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-2">
        {(startupConfig?.governanceAdminUrl ||
          startupConfig?.libreChatAdminUrl ||
          startupConfig?.gatewayUrl) && <div className="mx-2 border-t border-border-light" />}
        {startupConfig?.governanceAdminUrl && (
          <TooltipAnchor
            side="right"
            description={localize('com_nav_governance_admin')}
            render={
              <a
                href={startupConfig.governanceAdminUrl}
                aria-label={localize('com_nav_governance_admin')}
                data-testid="governance-admin-link"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-text-primary transition-colors hover:bg-surface-hover"
              >
                <Shield className="h-5 w-5" aria-hidden="true" />
              </a>
            }
          />
        )}
        {startupConfig?.libreChatAdminUrl && (
          <TooltipAnchor
            side="right"
            description={localize('com_nav_librechat_admin')}
            render={
              <a
                href={startupConfig.libreChatAdminUrl}
                aria-label={localize('com_nav_librechat_admin')}
                data-testid="chat-admin-link"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-text-primary transition-colors hover:bg-surface-hover"
              >
                <MessagesSquare className="h-5 w-5" aria-hidden="true" />
              </a>
            }
          />
        )}
        {startupConfig?.gatewayUrl && (
          <TooltipAnchor
            side="right"
            description={localize('com_nav_gateway')}
            render={
              <a
                href={startupConfig.gatewayUrl}
                aria-label={localize('com_nav_gateway')}
                data-testid="homepage-link"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-text-primary transition-colors hover:bg-surface-hover"
              >
                <Home className="h-5 w-5" aria-hidden="true" />
              </a>
            }
          />
        )}
        <div className="-mx-[13.5px] border-t border-border-light" />
        <Suspense fallback={<Skeleton className="h-9 w-9 rounded-lg" />}>
          <AccountSettings collapsed />
        </Suspense>
      </div>
    </div>
  );
}

export default memo(ExpandedPanel);
