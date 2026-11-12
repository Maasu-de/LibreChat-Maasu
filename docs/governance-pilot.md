# Governance Gateway pilot

The Governance Gateway calls LibreChat's group and usage-label read endpoints
with `GOVERNANCE_GATEWAY_SERVICE_CREDENTIAL`. This credential is server-only and
separate from `LIBRECHAT_SERVICE_CREDENTIAL`, which LibreChat sends in the reverse
direction. End-user OIDC tokens are never forwarded between the services.

Governance administrator mapping reads only a directly available claim from the
validated ID token. Entra group-overage resolution is not used for this mapping;
configure the IdP to emit the claim directly or access is denied. Existing generic
OIDC login and role-sync behavior remains unchanged.

Pilot OIDC administrators use the separate `GOVERNANCE_ADMIN` role. It inherits
USER chat permissions, and the API grants only group/membership operations plus
session verification. The group editor reads its capabilities at
`/api/admin/groups/capabilities` and searches membership candidates at
`/api/admin/groups/users/search`; all other management APIs return 403, even if broad grants
were previously assigned to the user or one of their groups. Full `ADMIN` remains distinct.
Previously mapped pilot OIDC ADMIN sessions are narrowed at the authentication
boundary immediately. Their persisted role migrates on the next login or refresh.

Set `GOVERNANCE_PILOT_ENABLED=true`, `GOVERNANCE_DLP_ENABLED=true`,
`OPENID_REUSE_TOKENS=true`,
`GOVERNANCE_API_BASE_URL` (the gateway's `/v1` base URL),
`LIBRECHAT_SERVICE_CREDENTIAL`, `PILOT_TENANT_ID`, and
`USAGE_PSEUDONYMIZATION_SECRET`. Keep `OPENAI_MODERATION=false`.
The gateway repository's Compose deployment fixes these switches for the pilot
and passes the tenant ID and pseudonymization secret to both servers.

`PILOT_TENANT_ID` must be the Gateway tenant UUID. References use its lowercase
canonical form in membership audits and usage-label resolution, matching the
Gateway's UUID representation. `USAGE_PSEUDONYMIZATION_SECRET` must be the same
stable server-only secret used by the Gateway backend for request audit actors
and usage pseudonyms. Copy both values from that deployment into LibreChat's
`.env`; do not generate a separate LibreChat secret or rotate it on restart.
Existing pilot installations must add both settings before deploying this audit
version: a missing value makes every group mutation return 503 before any write.
The settings are listed in `.env.example`. `deploy-compose.yml` loads them through
`env_file: .env`; `docker-compose.yml` mounts `.env` for server-side dotenv loading.
For another container orchestrator, inject both into the LibreChat server process
and the Gateway backend, then recreate/restart both with matching values.

Pilot configuration rejects disabled or missing OpenID token reuse. Every OpenID
authentication refresh contacts the IdP and synchronizes administrator entitlement.
OpenID users with older LibreChat refresh sessions must sign in again; those local
sessions cannot renew credentials in pilot mode, even after token reuse is enabled.

Administrator mapping must be explicit in pilot mode. Set `OPENID_ADMIN_ROLE`
and `OPENID_ADMIN_ROLE_PARAMETER_PATH` to the IdP's administrator value and
ID-token claim path. For bundled Keycloak use `governance-admin` and
`realm_access.roles`. Missing or blank settings reject startup, login, and
refresh. A stored LibreChat `ADMIN` role cannot substitute for the claim.
Outside pilot mode, the existing administrator mapping remains unchanged.

Set `GOVERNANCE_GATEWAY_SERVICE_CREDENTIAL` in LibreChat and the Gateway web
process to the same dedicated secret. The two read endpoints return 503 when it
is absent and 401 for a missing or incorrect bearer credential.

Group and membership audit delivery uses `LIBRECHAT_SERVICE_CREDENTIAL`, which
LibreChat sends to the Gateway. It does not use the reverse-direction
`GOVERNANCE_GATEWAY_SERVICE_CREDENTIAL`. The audit endpoint
defaults to the Gateway base URL with `/v1` replaced by
`/api/v1/internal/group-audit`, preserving any reverse-proxy prefix. To use a
different internal endpoint, set `GOVERNANCE_AUDIT_URL`, for example
`http://governance-backend:8000/api/v1/internal/group-audit`. Apply the Gateway's
`V11__group_governance_audit.sql` migration before enabling group management.
An unavailable audit service leaves durable pending events for retry; a missing
audit endpoint, service credential, tenant ID or pseudonymization secret prevents
group mutations with 503.

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


## Group audit delivery and recovery

MongoDB must support transactions (replica set). A group mutation and its outbox
event commit atomically; the request returns without contacting the Gateway.
The background worker polls every five seconds, claims events with a 30-second
lease, and sends up to 100 due events per pass. Crashed workers' leases expire.
Each payload carries `occurred_at`, the original UTC mutation time, separately
from the Gateway/PostgreSQL audit `timestamp` (recording time). Legacy pending
events use their original outbox `createdAt` when delivered.

The `governance_group_audit_outbox` collection stores `retryCount`,
`nextAttemptAt`, `status`, and a sanitized `lastError` containing only a fixed
category and optional HTTP status. Transient failures retry indefinitely with
exponential backoff from five seconds to five minutes. HTTP 4xx responses other
than 408, 425, and 429 quarantine the event. Later events keep delivering; the
mutation UUID keeps retries idempotent at the Gateway.

Alert on error logs containing `[Governance audit] Event quarantined` and
`[Governance audit] Quarantined events require replay`. The worker repeats a
quarantine-count alert at most once per minute while quarantined events remain.
Connect these logs to the deployment's alerting sink before production. Inspect
quarantined records in MongoDB and correct the rejected payload/configuration
before replay; no provider response body or token is retained as an error.

After building the packages, run from the repository root with the deployment's
`MONGO_URI` configured:

```sh
node scripts/replay-governance-audit.js <mutation-uuid> [more-mutation-uuids]
```

Replay resets the selected quarantined records to pending with immediate retry.
It preserves mutation IDs, actor/resource, and occurrence time. There is no
browser-facing replay endpoint.


Group audit comparisons follow the effective membership lookup: when a user has
`idOnTheSource`, only that exact source identifier grants membership. A leftover
native ObjectId alias does not keep the user in the group after the source alias
is removed. Audit events reflect that effective change without changing the
stored membership behavior. Unknown external identifiers still receive stable
pseudonymous references without persisting the raw identifiers in the outbox.
