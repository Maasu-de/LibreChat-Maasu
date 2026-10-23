# Governance Gateway pilot

Governance cross-system JWTs without a signed token-kind discriminator require
the Gateway's `X-Governance-Token-Proof` header. The server-generated HMAC binds
the selected token and configured source to a 60-second validity window using
`LIBRECHAT_SERVICE_CREDENTIAL`, shared with Gateway web and backend. OIDC signature,
issuer, audience, expiry and entitlement checks still apply. Signed Keycloak
`typ`, provider `token_use`, and access-token `at+jwt` header discriminators remain
supported without a proof. Conflicting signed type markers are rejected.

Only directly available configured claims are supported for login, administrator
mapping, and generic role synchronization. Microsoft Graph resolution of Entra
group-overage signals (`hasgroups`, `_claim_names`, `_claim_sources`) is outside
the current scope. Configure the IdP to emit the required claim directly; an
absent claim grants no entitlement.

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
`GOVERNANCE_API_BASE_URL` (the gateway's `/api/v1/dlp` base URL), and
`LIBRECHAT_SERVICE_CREDENTIAL`. Keep `OPENAI_MODERATION=false`.
The gateway repository's Compose deployment fixes these switches for the pilot.

Pilot configuration rejects disabled or missing OpenID token reuse. Every OpenID
authentication refresh contacts the IdP and synchronizes administrator entitlement.
OpenID users with older LibreChat refresh sessions must sign in again; those local
sessions cannot renew credentials in pilot mode, even after token reuse is enabled.

Administrator mapping must be explicit in pilot mode. Set `OPENID_ADMIN_ROLE`,
`OPENID_ADMIN_ROLE_PARAMETER_PATH`, and `OPENID_ADMIN_ROLE_TOKEN_KIND` to the IdP's
administrator value, claim path, and token source (`access`, `id`, or `userinfo`).
For bundled Keycloak use `governance-admin`, `realm_access.roles`, and `access`.
Missing or blank mapping settings, or an unsupported token source, reject pilot
startup, OpenID login, and authentication refresh. A stored LibreChat `ADMIN` role
cannot substitute for this mapping. Outside pilot mode, administrator mapping
remains optional.

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

After successful OIDC rotation, refresh credentials are retained even if a later
administrator/userinfo lookup fails. Such failures issue no new authorized
bearer and can be retried. Governance OIDC discovery is cached for five minutes;
userinfo entitlement responses are not cached.
