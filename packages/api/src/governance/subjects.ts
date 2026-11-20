import { createHmac } from 'node:crypto';

/** Match the Gateway's canonical tenant UUID in usage and request audit references. */
export function pseudonymizeUserId(secret: string, tenantId: string, userId: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${tenantId.toLowerCase()}:${userId}`)
    .digest('hex');
  return `sha256:${digest}`;
}
