# Governance Gateway pilot

Set `GOVERNANCE_PILOT_ENABLED=true`, `GOVERNANCE_DLP_ENABLED=true`,
`GOVERNANCE_API_BASE_URL` (the gateway's `/v1` base URL), and
`LIBRECHAT_SERVICE_CREDENTIAL`. Keep `OPENAI_MODERATION=false`.
The gateway repository's Compose deployment fixes these switches for the pilot.

The [capability inventory and deployment baseline](https://github.com/Maasu-de/ai-governance-gateway/blob/main/docs/librechat-pilot-features.md)
classifies supported text chat and the integrations excluded from the pilot.
Only the server-configured **AI Governance Gateway** endpoint and its fetched
model catalog are available. Restrictions apply equally to administrators,
configuration overrides, saved conversation settings and direct API requests.
Existing history remains readable; start a new gateway chat when older history
contains attachments, tools or incompatible settings.

The policy lives in `packages/api/src/governance`: configuration restrictions
run before application defaults and after database overrides; the Express guard
runs before feature routers; saved history is checked before chat initialization;
the outbound adapter checks the final text request and forwards its signed DLP
token. The startup flag also hides unsupported controls and overrides persisted
speech/tool choices. Leaving pilot mode disabled preserves upstream behavior.

Rebuild the fork after applying these changes; updating YAML alone is insufficient.
Use Node 24.16.0 and the repository's locked dependencies.

```sh
# From packages/api
npx jest --runInBand src/governance/tests src/app/service.spec.ts \
  src/endpoints/config/endpoints.spec.ts src/endpoints/custom/initialize.spec.ts

# From client
npx jest --runInBand --coverage=false useGenerationsByLatest.pilot \
  components/Nav/Settings/__tests__ \
  hooks/Chat/__tests__/useChatFunctions.governance.spec.tsx
```

Deployment smoke checks: send text and follow-ups, change logical model, test
WARN/MASK/BLOCK, stop/reconnect a stream, inspect saved history and manually rename
a conversation. Check both regular and admin accounts; unsupported feature APIs
must return 403 even when invoked directly. No live-provider calls are required
by the regression tests.
