# Governance DLP follow-ups

The DLP approval flow covers only a normal, plain-text chat submission. Such a message is sent
to the gateway's `POST /api/v1/dlp/chat/completions` with `require_user_approval: true`. When
DLP finds something in the submitted text, the gateway returns a review instead of a completion.
LibreChat ends the turn without saving the message, shows the review in the intervention
dialog, and on approval sends the masked messages again with the review's `dlp_token`.
LibreChat makes no separate DLP check call; the gateway's earlier `POST /api/v1/dlp/check`
and `X-DLP-Token` flow has been removed.

The following work is intentionally deferred.

- Extend the contract and integration to attachments, multimodal content, edited messages, continued messages, tools, agent handoffs, assistants, and remote API routes. These sends skip the approval flow today and reach the gateway's completion endpoint as built, without being reduced to the text-only request.
- Add end-to-end coverage against a running Governance Backend.
- Expand the Gateway request contract before enabling governed support for LibreChat parameters beyond its text-only allow-list. The current Gateway rejects fields such as `user`, `stream_options`, sampling controls, tools, and provider extensions. This integration forwards only `model`, string `messages`, `stream`, and `temperature` to a governed completion so unsupported fields never reach a model unscanned. Supporting the omitted parameters requires a contract decision and Gateway work; no such work is included here.

## Required deployment configuration

LibreChat needs three server-side values, all of which
`ai-governance-gateway/deploy/compose.yaml` passes to the LibreChat service:

- `GOVERNANCE_API_BASE_URL`, set to the gateway's DLP completions base URL, for example
  `http://governance-backend:8000/api/v1/dlp`. The `/v1` base URL serves only the model list
  and cannot complete a chat.
- `LIBRECHAT_SERVICE_CREDENTIAL`.
- `GOVERNANCE_DLP_ENABLED=true`.

## Gateway contract

The contract is documented in `ai-governance-gateway/docs/dlp-chat-completions-api.md`. This
integration relies on the following parts of it:

- A review arrives as the `dlp` field of the stage 1 response, as the first server-sent event
  or as a JSON body, with `review_id`, `action`, `policy_version`, `findings`, `messages`,
  `dlp_token`, and `expires_at`. A `BLOCK` review has no `messages` or `dlp_token` and cannot
  be approved.
- Finding offsets are code points within the message at the finding's `location`.
- Stage 2 sends the review's `messages` unchanged, with `require_user_approval: true` and the
  `dlp_token` in the request body.
