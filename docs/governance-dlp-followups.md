# Governance DLP follow-ups

This ticket covers only a normal, plain-text chat submission. The following work is intentionally deferred.

- Build an intervention component that renders `decision`, `findings`, `masked_preview`, `policy_version`, and `dlp_token`, then lets a user review or resubmit a WARN or MASK result. This ticket does not surface WARN or MASK to the client at all: the preflight lets both through and the gateway-side DLP token performs any masking. The `GOVERNANCE_INTERVENTION` error type, its `com_error_governance_intervention` string, and the WARN/MASK branch of the deny-payload builder were removed as unreachable; the component work must reintroduce whatever client contract it needs (likely a non-error SSE event rather than an error type, since WARN/MASK still complete).
- Extend the contract and integration to attachments, multimodal content, edited messages, continued messages, tools, agent handoffs, assistants, and remote API routes.
- Add end-to-end coverage against a running Governance Backend after contract #44 is confirmed.
- Coordinate with the Governance Backend owner on a single preflight token protocol. The current gateway binds a token to the final OpenAI message list, while LibreChat's UI preflight only has the submitted text. LibreChat therefore performs an exact server-side check immediately before the governed completion to mint the forwarded token. A gateway contract that can issue a token for the canonical LibreChat submission would remove that second check.
- Expand the Gateway request contract before enabling governed support for LibreChat parameters beyond its text-only allow-list. The current Gateway rejects fields such as `user`, `stream_options`, sampling controls, tools, and provider extensions. This integration forwards only `model`, string `messages`, `stream`, and `temperature` to a governed completion so unsupported fields never reach a model unscanned. Supporting the omitted parameters requires a contract decision and Gateway work; no such work is included here.

No gateway changes are included in this ticket.

## Required deployment handoff

The existing `ai-governance-gateway/deploy/compose.yaml` passes
`GOVERNANCE_API_BASE_URL` and `LIBRECHAT_SERVICE_CREDENTIAL` to LibreChat, which this
integration already uses. It must also pass `GOVERNANCE_DLP_ENABLED=true` to the
LibreChat service before deployment. This is a gateway deployment configuration change,
not a Gateway source-code change, and was intentionally not made here.

## Contract confirmation pending #44

The checked-in Gateway contract currently returns `action` (not `decision`), plus
`findings`, `masked_preview`, `policy_version`, and `dlp_token`. This integration
accepts either `action` or a future `decision` spelling. The Gateway currently requires
its `dlp_token` on every completion and binds it to the exact final message list; that is
why the final server-side outbound check is retained. Confirm these details with #44's
owner before changing either side of the contract.
