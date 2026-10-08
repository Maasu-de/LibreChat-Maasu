import { logger, SystemCapabilities } from '@librechat/data-schemas';
import { SystemRoles } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { HasCapabilityFn } from '~/middleware/capabilities';
import { getAdminPanelUrl } from '~/auth/exchange';

type NavigationUser = Partial<Pick<IUser, 'id' | '_id' | 'role' | 'tenantId'>>;
type NavigationConfig = Pick<
  TStartupConfig,
  'gatewayUrl' | 'libreChatAdminUrl' | 'allowAccountDeletion'
>;

function configuredHttpUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export async function resolveConfigNavigation({
  user,
  webPublicUrl,
  adminPanelUrl,
  allowAccountDeletion,
  hasCapability,
}: {
  user: NavigationUser;
  webPublicUrl?: string;
  adminPanelUrl?: string;
  allowAccountDeletion: boolean;
  hasCapability: HasCapabilityFn;
}): Promise<NavigationConfig> {
  const gatewayUrl = configuredHttpUrl(webPublicUrl);
  const adminUrl = configuredHttpUrl(adminPanelUrl || getAdminPanelUrl());
  const navigation: NavigationConfig = { gatewayUrl, allowAccountDeletion };
  if (!adminUrl && allowAccountDeletion) {
    return navigation;
  }

  const userId = user.id ?? user._id?.toString();
  if (!userId) {
    return navigation;
  }

  try {
    const canAccessAdmin = await hasCapability(
      { id: userId, role: user.role ?? '', tenantId: user.tenantId },
      SystemCapabilities.ACCESS_ADMIN,
    );
    if (!canAccessAdmin) {
      return navigation;
    }
    if (adminUrl && user.role === SystemRoles.ADMIN) {
      navigation.libreChatAdminUrl = gatewayUrl
        ? `${gatewayUrl}/api/auth/open-librechat-admin`
        : adminUrl;
    }
    navigation.allowAccountDeletion = true;
  } catch (err) {
    logger.warn(`[config] ACCESS_ADMIN capability check failed: ${(err as Error).message}`);
  }

  return navigation;
}
