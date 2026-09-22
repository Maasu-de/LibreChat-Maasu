import { z } from 'zod';
import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, TCustomConfig, TEndpointsConfig } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { GovernanceSubmissionBody } from './dlp';
import { isPlainTextSubmission, isGovernanceDlpEnabled } from './dlp';
import { isEnabled } from '~/utils/common';

export const GOVERNANCE_ENDPOINT = 'AI Governance Gateway';

export function isGovernancePilotEnabled(): boolean {
  return isEnabled(process.env.GOVERNANCE_PILOT_ENABLED);
}

export function assertGovernancePilotEnvironment(): void {
  if (!isGovernancePilotEnabled()) {
    return;
  }
  if (
    !isGovernanceDlpEnabled() ||
    !process.env.GOVERNANCE_API_BASE_URL ||
    !process.env.LIBRECHAT_SERVICE_CREDENTIAL
  ) {
    throw new Error('Governed pilot requires DLP, a gateway URL, and a service credential.');
  }
  if (isEnabled(process.env.OPENAI_MODERATION)) {
    throw new Error('Governed pilot does not support external OpenAI moderation.');
  }
}

/** Apply the deployment boundary before AppService derives tools and UI permissions. */
export function applyGovernancePilotConfig(config: Partial<TCustomConfig>): Partial<TCustomConfig> {
  if (!isGovernancePilotEnabled()) {
    return config;
  }
  assertGovernancePilotEnvironment();
  const endpoint = config.endpoints?.custom?.find(({ name }) => name === GOVERNANCE_ENDPOINT);
  if (!endpoint) {
    throw new Error('Governed pilot requires the AI Governance Gateway custom endpoint.');
  }

  const deniedPermissions = { use: false, create: false, share: false, public: false };
  return {
    ...config,
    endpoints: {
      custom: [
        {
          name: GOVERNANCE_ENDPOINT,
          apiKey: '${LIBRECHAT_SERVICE_CREDENTIAL}',
          baseURL: '${GOVERNANCE_API_BASE_URL}',
          headers: { 'X-LibreChat-User-ID': '{{LIBRECHAT_USER_ID}}' },
          models: { default: endpoint.models?.default ?? [], fetch: true },
          titleConvo: false,
          summarize: false,
        },
      ],
    },
    modelSpecs: undefined,
    mcpServers: undefined,
    webSearch: undefined,
    memory: undefined,
    includedTools: [],
    interface: {
      ...config.interface,
      endpointsMenu: false,
      modelSelect: true,
      parameters: false,
      presets: false,
      multiConvo: false,
      sidePanel: false,
      agents: deniedPermissions,
      remoteAgents: deniedPermissions,
      mcpServers: deniedPermissions,
      marketplace: { use: false },
      memories: false,
      runCode: false,
      webSearch: false,
      fileSearch: false,
      fileCitations: false,
    },
    fileConfig: {
      endpoints: {
        default: { disabled: true },
        [GOVERNANCE_ENDPOINT]: { disabled: true },
      },
    },
    speech: {
      speechTab: {
        conversationMode: false,
        advancedMode: false,
        speechToText: false,
        textToSpeech: false,
      },
    },
  };
}

export function filterGovernanceEndpoints(config: TEndpointsConfig): TEndpointsConfig {
  if (!isGovernancePilotEnabled()) {
    return config;
  }
  const endpoint = config?.[GOVERNANCE_ENDPOINT];
  return endpoint ? { [GOVERNANCE_ENDPOINT]: endpoint } : {};
}

const disabledToolsSchema = z
  .object({
    mcp: z.array(z.string()).max(0).optional(),
    web_search: z.literal(false).optional(),
    file_search: z.literal(false).optional(),
    execute_code: z.literal(false).optional(),
    artifacts: z.literal('').optional(),
  })
  .strict()
  .nullish();

type PilotSubmission = GovernanceSubmissionBody & {
  endpoint?: string;
  endpointType?: string;
  useResponsesApi?: boolean;
};

/** Runs before feature routers, including API-key authenticated agent APIs. */
export function enforceGovernancePilot(
  req: Request<object, object, PilotSubmission>,
  res: Response,
  next: NextFunction,
): void {
  if (!isGovernancePilotEnabled()) {
    next();
    return;
  }

  let path: string;
  try {
    path = decodeURIComponent(req.path).replace(/\/+$/, '').toLowerCase();
  } catch {
    res.status(400).json({ error: 'Invalid request path' });
    return;
  }
  const deny = (): void => {
    res.status(403).json({
      error: 'governance_unsupported_feature',
      message: 'This feature is unavailable in the governed text-only pilot.',
    });
  };
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (
    /^\/(actions|assistants|mcp|memories|keys|api-keys)(\/|$)/.test(path) ||
    /^\/convos\/(gen_title|import)(\/|$)/.test(path)
  ) {
    deny();
    return;
  }
  if (path === '/files' || path.startsWith('/files/')) {
    if (isRead) {
      next();
      return;
    }
    deny();
    return;
  }
  if (path !== '/agents' && !path.startsWith('/agents/')) {
    next();
    return;
  }
  if (
    (isRead && /^\/agents\/chat\/(active|(?:stream|status)\/[^/]+)$/.test(path)) ||
    (req.method === 'POST' && path === '/agents/chat/abort')
  ) {
    next();
    return;
  }
  const body = req.body;
  if (
    req.method !== 'POST' ||
    path !== `/agents/chat/${GOVERNANCE_ENDPOINT.toLowerCase()}` ||
    body?.endpoint !== GOVERNANCE_ENDPOINT ||
    (body.endpointType != null && body.endpointType !== EModelEndpoint.custom) ||
    body.useResponsesApi === true ||
    !disabledToolsSchema.safeParse(body.ephemeralAgent).success ||
    !isPlainTextSubmission(body)
  ) {
    deny();
    return;
  }
  next();
}

/** Reject old binary/tool history before LibreChat reloads files or invokes retrieval. */
export function assertGovernancePilotHistory(
  messages: Pick<TMessage, 'files' | 'content'>[],
): void {
  if (!isGovernancePilotEnabled()) {
    return;
  }
  for (const message of messages) {
    if (
      (message.files != null && (!Array.isArray(message.files) || message.files.length > 0)) ||
      (message.content != null &&
        (!Array.isArray(message.content) ||
          message.content.some(
            (part) =>
              part.type !== ContentTypes.TEXT &&
              part.type !== ContentTypes.ERROR &&
              part.type !== ContentTypes.THINK,
          )))
    ) {
      throw new Error(
        'This conversation contains unsupported content. Start a new governed text chat.',
      );
    }
  }
}
