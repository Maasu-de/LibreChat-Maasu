# Governance Gateway pilot

Set `GOVERNANCE_PILOT_ENABLED=true`, `GOVERNANCE_DLP_ENABLED=true`,
`GOVERNANCE_API_BASE_URL` (the gateway's `/api/v1/dlp` base URL), and
`LIBRECHAT_SERVICE_CREDENTIAL`. Keep `OPENAI_MODERATION=false`.
The gateway repository's Compose deployment fixes these switches for the pilot.

Group and membership auditing uses the same service credential. The audit endpoint
defaults to the Gateway base URL with `/api/v1/dlp` replaced by
`/api/v1/internal/group-audit`, preserving any reverse-proxy prefix. To use a
different internal endpoint, set `GOVERNANCE_AUDIT_URL`, for example
`http://governance-backend:8000/api/v1/internal/group-audit`. Apply the Gateway's
`V11__group_governance_audit.sql` migration before enabling group management.
An unavailable audit service leaves durable pending events for retry; a missing
audit endpoint or credential prevents group mutations.

MongoDB must support transactions so group writes and their audit outbox entries
commit together. Both `docker-compose.yml` and `deploy-compose.yml` configure a
single-member replica set named `rs0`. Their health check initializes an unconfigured
replica set and waits for a writable primary before the API starts. Existing
`data-node` contents are retained when MongoDB is restarted with this configuration;
do not delete the data directory. Existing replica sets must use the matching set
name and member addresses, or supply a Compose override for their topology.
An external MongoDB deployment must be a replica set or sharded cluster, with a
matching `MONGO_URI` supplied through a Compose override. For a backend running
outside Docker, use an address reachable from that host and configure replica-set
member addresses accordingly; the bundled member advertises `mongodb:27017` on
the Compose network.

Customer OIDC providers that require a token exchange for userinfo must set
`OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED=true` and, when needed,
`OPENID_ON_BEHALF_FLOW_USERINFO_SCOPE`. Login, refresh, and governance group and
usage-label lookups use the same exchange helper and configured LibreChat OIDC
client. The provider must allow that client to exchange the forwarded governance
administrator token. Governance lookups retain `OIDC_USERINFO_URI` as an optional
userinfo endpoint override and require the returned subject to match the verified
administrator token.

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
