import type { TEphemeralAgent } from 'librechat-data-provider';

export const hasSelectedEphemeralTools = (ephemeralAgent?: TEphemeralAgent | null) =>
  (Array.isArray(ephemeralAgent?.mcp) && ephemeralAgent.mcp.length > 0) ||
  ephemeralAgent?.web_search === true ||
  ephemeralAgent?.file_search === true ||
  ephemeralAgent?.execute_code === true;
