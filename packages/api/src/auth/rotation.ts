import type { CookieOptions, Response } from 'express';

interface RefreshSession {
  openidTokens?: { refreshToken?: string };
}

export function preserveRotatedOpenIdRefreshToken(
  refreshToken: string | undefined,
  session: RefreshSession | undefined,
  response: Response,
  options: CookieOptions,
): void {
  if (!refreshToken) return;
  if (session) session.openidTokens = { ...session.openidTokens, refreshToken };
  response.cookie('refreshToken', refreshToken, { ...options, httpOnly: true });
}
