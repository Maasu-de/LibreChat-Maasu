import { isEphemeralAgentId } from 'librechat-data-provider';
import type { IUser, IMessage } from '@librechat/data-schemas';
import type { RequestHandler, Response } from 'express';
import { GOVERNANCE_ENDPOINT, isGovernancePilotEnabled } from './mode';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Submission = { [key: string]: JsonValue };

const restrictedFields = new Set([
  'files',
  'attachments',
  'tools',
  'tool_resources',
  'tool_calls',
  'functions',
  'assistant_id',
  'addedConvo',
  'editedContent',
  'isContinued',
  'isRegenerate',
  'isEdited',
  'editedMessageId',
  'overrideParentMessageId',
  'useResponsesApi',
  'disableStreaming',
  'web_search',
  'file_search',
  'execute_code',
  'mcp',
  'artifacts',
  'skills',
  'manualSkills',
  'skill_ids',
  'subagents',
  'baseURL',
  'baseUrl',
  'reverseProxyUrl',
  'apiKey',
  'headers',
  'summarize',
  'content',
  'messages',
]);

function populated(value: JsonValue): boolean {
  return (
    value != null && value !== false && value !== '' && (!Array.isArray(value) || value.length > 0)
  );
}

function hasUnsupportedSettings(body: Submission): boolean {
  return Object.entries(body).some(([key, value]) => {
    if (restrictedFields.has(key) && populated(value)) {
      return true;
    }
    if (
      (key === 'endpoint' || key === 'provider') &&
      value != null &&
      value !== GOVERNANCE_ENDPOINT
    ) {
      return true;
    }
    if (key === 'endpointType' && value != null && value !== 'custom') {
      return true;
    }
    if (
      key === 'agent_id' &&
      value != null &&
      (typeof value !== 'string' || !isEphemeralAgentId(value))
    ) {
      return true;
    }
    return (
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      hasUnsupportedSettings(value)
    );
  });
}

function deny(res: Response): void {
  res.status(403).json({
    type: 'governance_feature_unsupported',
    message:
      'This feature is unavailable in the governed text-only pilot. Start a new gateway chat.',
  });
}

/** Mounted before feature routers, including API-key-authenticated agent APIs. */
export const enforceGovernancePilot: RequestHandler = (req, res, next) => {
  if (!isGovernancePilotEnabled()) {
    next();
    return;
  }
  let path: string;
  try {
    path = decodeURIComponent(req.path).replace(/\/+$/, '').toLowerCase();
  } catch {
    deny(res);
    return;
  }
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  const chat = '/agents/chat';
  if (path.startsWith(`${chat}/`) || path === chat) {
    if (
      (readOnly && /^\/agents\/chat\/(active|status\/[^/]+|stream\/[^/]+)$/.test(path)) ||
      (req.method === 'POST' && path === `${chat}/abort`)
    ) {
      next();
      return;
    }
    const body: Submission = req.body;
    if (
      req.method !== 'POST' ||
      path !== `${chat}/${GOVERNANCE_ENDPOINT.toLowerCase()}` ||
      !body ||
      Array.isArray(body) ||
      body.endpoint !== GOVERNANCE_ENDPOINT ||
      typeof body.text !== 'string' ||
      !body.text.trim() ||
      hasUnsupportedSettings(body)
    ) {
      deny(res);
      return;
    }
    next();
    return;
  }
  if (
    /^\/(agents|assistants|actions|keys|api-keys|mcp|memories|skills|presets|chat)(\/|$)/.test(
      path,
    ) ||
    (/^\/admin\/(config|skills)(\/|$)/.test(path) && !readOnly) ||
    (/^\/files(\/|$)/.test(path) && !readOnly) ||
    (/^\/files\/speech(\/|$)/.test(path) && path !== '/files/speech/config') ||
    /^\/convos\/(import|gen_title)(\/|$)/.test(path) ||
    (/^\/messages(\/|$)/.test(path) &&
      !readOnly &&
      req.method !== 'DELETE' &&
      !path.endsWith('/feedback'))
  ) {
    deny(res);
    return;
  }
  next();
};

type HistoryMessage = Pick<IMessage, 'text' | 'content' | 'files' | 'attachments'>;

export function isGovernanceTextHistory(messages: HistoryMessage[]): boolean {
  return messages.every(
    (message) =>
      !message.files?.length &&
      !message.attachments?.length &&
      (!message.content?.length ||
        message.content.every(
          (part) =>
            part != null && typeof part === 'object' && 'type' in part && part.type === 'text',
        )),
  );
}

/** Check saved content before initialization can reload files or retrieve tool resources. */
export function createGovernanceHistoryGuard(
  getMessages: (
    filter: { conversationId: string; user: string },
    select: string,
  ) => Promise<HistoryMessage[]>,
): RequestHandler {
  return async (req, res, next) => {
    if (
      !isGovernancePilotEnabled() ||
      !req.body.conversationId ||
      req.body.conversationId === 'new'
    ) {
      next();
      return;
    }
    try {
      const messages = await getMessages(
        { conversationId: req.body.conversationId, user: (req.user as IUser).id },
        'text content files attachments',
      );
      if (!isGovernanceTextHistory(messages)) {
        deny(res);
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
