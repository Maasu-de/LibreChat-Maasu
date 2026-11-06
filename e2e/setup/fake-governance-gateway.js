#!/usr/bin/env node

/**
 * Fake Governance Gateway for the governed-pilot e2e specs (`e2e/specs/governance`).
 *
 * Serves the two routes LibreChat's pilot mode calls under `GOVERNANCE_API_BASE_URL`:
 * `GET /v1/models` and `POST /v1/chat/completions`. It follows the real
 * gateway's review protocol: with `require_user_approval`, findings in the last message or
 * `review_message_indices` return a stage 1 review, and a stage 2 request with the review's
 * `dlp_token` completes the approved messages. Other earlier messages do not open a
 * review; the policy still applies to them. Assistant messages are not scanned.
 *
 * Detection is deterministic, so specs choose the outcome through their content:
 * - an IBAN (`DE` + 20 digits) is masked as `[IBAN]`;
 * - an email address is a warning;
 * - `PROJECT-NIGHTSHADE` is a blocked confidential term;
 * - `PROJECT-FRIENDLY-MASK` is masked as `[REDACTED]` with the category label `Codenames`;
 * - a message containing `E2E-SLOW` gets its review two seconds late, so specs can type meanwhile.
 *
 * Each completion reports what reached the model, so specs can assert on it:
 * `E2E gateway reply [attachment=yes iban=masked email=no history-iban=none]`.
 */

const http = require('http');
const { randomUUID } = require('crypto');

const PORT = parseInt(process.env.E2E_GOVERNANCE_GATEWAY_PORT || '8766', 10);
const HOST = '127.0.0.1';
const BASE_PATH = '/v1';
const MODEL = 'e2e-governed-model';
const REVIEW_TTL_SECONDS = 600;
const SLOW_MARKER = 'E2E-SLOW';
const SLOW_REVIEW_MS = 2000;

const IBAN = /DE\d{20}/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi;
const BLOCKED_TERM = /PROJECT-NIGHTSHADE/g;

const RULES = [
  { pattern: IBAN, category: 'IBAN_CODE', action: 'MASK', replacement: '[IBAN]' },
  { pattern: EMAIL, category: 'EMAIL_ADDRESS', action: 'WARN' },
  { pattern: BLOCKED_TERM, category: 'CODE_NAME', action: 'BLOCK' },
  {
    pattern: /PROJECT-FRIENDLY-MASK/g,
    category: 'CUSTOM_E2E_CODENAMES',
    label: 'Codenames',
    action: 'MASK',
    replacement: '[REDACTED]',
  },
];
const SEVERITY = ['ALLOW', 'WARN', 'MASK', 'BLOCK'];

/** Approval tokens of open reviews, mapped to the masked messages they approve. */
const approvals = new Map();

const codePoints = (text) => Array.from(text).length;

function scan(messages) {
  const findings = [];
  messages.forEach((message, index) => {
    if (!['user', 'system'].includes(message.role) || typeof message.content !== 'string') {
      return;
    }
    for (const { pattern, category, label, action, replacement } of RULES) {
      for (const match of message.content.matchAll(pattern)) {
        const start = codePoints(message.content.slice(0, match.index));
        findings.push({
          location: `/messages/${index}/content`,
          start,
          end: start + codePoints(match[0]),
          category,
          ...(label ? { label } : {}),
          action,
          ...(replacement ? { replacement } : {}),
        });
      }
    }
  });
  return findings;
}

function decide(findings) {
  return findings.reduce(
    (decision, { action }) =>
      SEVERITY.indexOf(action) > SEVERITY.indexOf(decision) ? action : decision,
    'ALLOW',
  );
}

function mask(messages, findings) {
  return messages.map((message, index) => {
    const masks = findings
      .filter((f) => f.location === `/messages/${index}/content` && f.action === 'MASK')
      .sort((a, b) => b.start - a.start);
    if (masks.length === 0) {
      return message;
    }
    const chars = Array.from(message.content);
    for (const { start, end, replacement } of masks) {
      chars.splice(start, end - start, replacement);
    }
    return { ...message, content: chars.join('') };
  });
}

function ibanState(text) {
  if (new RegExp(IBAN.source).test(text)) {
    return 'raw';
  }
  return text.includes('[IBAN]') ? 'masked' : 'none';
}

/** Describes what reached the model, for the specs to assert on. */
function describe(messages, agent) {
  const users = messages.filter((m) => m.role === 'user');
  const last = users.at(-1)?.content ?? '';
  const history = users
    .slice(0, -1)
    .map((m) => m.content)
    .join('\n');
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  return [
    `attachment=${last.includes('Attached document(s):') ? 'yes' : 'no'}`,
    `iban=${ibanState(last)}`,
    `email=${new RegExp(EMAIL.source, 'i').test(last) ? 'yes' : 'no'}`,
    `history-iban=${ibanState(history)}`,
    ...(last.includes('[REDACTED]') ? ['codename=masked'] : []),
    ...(agent
      ? [
          `instruction-iban=${ibanState(instructions)}`,
          `instruction-email=${new RegExp(EMAIL.source, 'i').test(instructions) ? 'yes' : 'no'}`,
        ]
      : []),
  ].join(' ');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendEvents(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of events) {
    res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
  }
  res.end();
}

function chunk(id, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function complete(res, messages, agent) {
  const id = `chatcmpl-${randomUUID()}`;
  sendEvents(res, [
    chunk(id, { role: 'assistant', content: '' }),
    chunk(id, { content: `E2E gateway reply [${describe(messages, agent)}]` }),
    chunk(id, {}, 'stop'),
    '[DONE]',
  ]);
}

function review(res, messages, findings, decision) {
  const dlp = {
    review_id: randomUUID(),
    action: decision,
    policy_version: 1,
    findings,
  };
  if (decision !== 'BLOCK') {
    const token = randomUUID();
    const approved = mask(messages, findings);
    approvals.set(token, approved);
    Object.assign(dlp, {
      messages: approved,
      dlp_token: token,
      expires_at: Math.floor(Date.now() / 1000) + REVIEW_TTL_SECONDS,
    });
  }
  sendEvents(res, [
    { id: `dlprev-${dlp.review_id}`, object: 'chat.completion.chunk', choices: [], dlp },
    '[DONE]',
  ]);
}

function handleCompletion(res, body, agent) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  console.log(
    `[e2e-gateway] completion messages=${messages.length} approval=${body.require_user_approval === true} token=${body.dlp_token !== undefined}`,
  );

  if (body.dlp_token !== undefined) {
    const approved = approvals.get(body.dlp_token);
    approvals.delete(body.dlp_token);
    if (!approved || JSON.stringify(approved) !== JSON.stringify(messages)) {
      sendJson(res, 403, {
        error: { message: 'Invalid approval', type: 'governance_error', code: 'dlp_token_invalid' },
      });
      return;
    }
    complete(res, approved, agent);
    return;
  }

  const findings = scan(messages);
  const decision = decide(findings);
  const lastLocation = `/messages/${messages.length - 1}/content`;
  const reviewLocations = new Set([
    lastLocation,
    ...(body.review_message_indices ?? []).map((index) => `/messages/${index}/content`),
  ]);
  if (
    body.require_user_approval === true &&
    findings.some((f) => reviewLocations.has(f.location))
  ) {
    const content = messages.at(-1)?.content;
    const delay = typeof content === 'string' && content.includes(SLOW_MARKER) ? SLOW_REVIEW_MS : 0;
    setTimeout(() => review(res, messages, findings, decision), delay);
    return;
  }
  if (decision === 'BLOCK') {
    sendJson(res, 403, {
      error: { message: 'Blocked by policy', type: 'governance_error', code: 'policy_blocked' },
    });
    return;
  }
  complete(res, mask(messages, findings), agent);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (data) => chunks.push(data));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && pathname === `${BASE_PATH}/models`) {
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'e2e' }],
    });
    return;
  }
  if (req.method === 'POST' && pathname === `${BASE_PATH}/chat/completions`) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: { message: 'Invalid JSON', code: 'invalid_request' } });
      return;
    }
    handleCompletion(res, body, Boolean(req.headers['x-librechat-agent-id']));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[e2e] Fake governance gateway listening on http://${HOST}:${PORT}${BASE_PATH}`);
});
