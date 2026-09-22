# Governed deployment

`GOVERNANCE_PILOT_ENABLED=true` restricts this fork to plain-text streaming chat
through the **AI Governance Gateway** custom endpoint, for users and administrators.
It requires `GOVERNANCE_DLP_ENABLED=true`, `GOVERNANCE_API_BASE_URL`, and
`LIBRECHAT_SERVICE_CREDENTIAL`; external `OPENAI_MODERATION` must be disabled.

Use the paired [Gateway deployment configuration](https://github.com/Maasu-de/ai-governance-gateway/blob/main/deploy/librechat.yaml).
The [pilot capability inventory](https://github.com/Maasu-de/ai-governance-gateway/blob/main/docs/librechat-pilot-features.md)
classifies supported and restricted features and explains each governance reason.
Deploy both repositories' changes together and rebuild the LibreChat image.

The fork pins server-side endpoint configuration, filters endpoint discovery, and
rejects unsupported APIs and submissions before feature handlers run. UI controls
for tools, speech, imports and advanced message operations are also hidden.
Read-only file metadata and existing file resources remain available because the
conversation renderer needs them to load saved history; all file mutations and
file-bearing model submissions remain blocked.
The final outbound DLP adapter is mandatory even when a request has no earlier
preflight eligibility flag. Unset/false pilot mode retains normal fork behavior.

Normal messages, follow-ups, model selection, history, local search, manual titles,
copying and stream controls remain available. Existing incompatible conversations
may be rejected; start a new gateway conversation. Server environment/source
administrators remain trusted deployment operators.

Run regression tests from `packages/api`:

```sh
npx jest --runInBand src/governance/tests src/endpoints/custom/initialize.spec.ts
```

Run client governance tests from `client`:

```sh
npx jest --runInBand --coverage=false src/hooks/Chat/__tests__/useChatFunctions.governance.spec.tsx
```
