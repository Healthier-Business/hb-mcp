---
description: The limits that apply to keys and tokens, every error code and what to do about it, retry rules and how idempotency keys make repeated creates safe.
---
# Rate limits, errors and idempotency

A reference for the three things every production integration has to get right. The same rules apply in a sandbox and in the live Hub, so you can test them before you go live.

## Rate limits

| Limit | Value | Where you see it |
| --- | --- | --- |
| Per key, per hour | Set when the key is created (default 1,000; 10 to 10,000 in a sandbox) | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on **every** answer |
| Token exchange | 10 a minute | `429 rate_limited` on `POST /auth/token` |
| Request body | 1 MB (1,048,576 bytes) in a sandbox | `413 payload_too_large` |
| Access token | 3,600 seconds | `401 invalid_token` afterwards |
| Refresh token | 604,800 seconds (7 days), single use | `401 invalid_token` / `invalid_credentials` |
| Webhook retries | 5 attempts, 1, 5, 15 and 60 minutes apart | Delivery log |
| Webhook switch-off | After 25 failed deliveries in a row | Endpoint shows *Off* |

When you go over a limit the answer is `429` with `error: "rate_limited"` and a `Retry-After` header in seconds. Do not retry before then.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 37
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1793300400

{"error":"rate_limited","message":"Too many requests.","request_id":"01JD8Q..."}
```

> **Tip: Stay below the limit.**
>
> Cache lists and tokens, page with `per_page` instead of many single reads, and prefer webhooks to polling. The [request log](hb://guides/portal-request-log-and-debugging) shows which key used its hour up.

## Errors

Every error has the same shape:

```json
{
  "error": "validation_failed",
  "message": "The email field must be a valid email address.",
  "details": { "email": ["The email field must be a valid email address."] },
  "request_id": "01JD8Q4Z8E5YF6Z2W0KQ7M9N3A"
}
```

* `error` is a stable, snake case **code**: build your logic on it, not on the message.
* `message` is for people and may change.
* `details` maps each field to its messages (validation only).
* `request_id` is also the `X-Request-Id` header. Quote it to support.

| Status | Codes | What it means | What to do |
| --- | --- | --- | --- |
| 400 | `bad_request` | The JSON could not be parsed | Fix the body |
| 401 | `unauthenticated`, `invalid_token`, `invalid_credentials` | No or bad token, key or refresh token | Refresh the token; check the key |
| 402 | `insufficient_credits`, `payment_required` | Not enough credits (`required`, `available`), or the candidate must pay (`payment_url`) | Add credits or send the candidate the link |
| 403 | `insufficient_scope`, `ip_not_allowed`, `key_inactive`, `portal_unavailable`, `forbidden` | The key may not do this | Edit the key or allowlist; the message names the scope |
| 404 | `not_found` | No such record, or it belongs to another client (both answer the same, so ids cannot be probed) | Check the id |
| 405 | `method_not_allowed` | Wrong method; the `Allow` header lists the right ones | Use the right method |
| 409 | `conflict`, `idempotency_conflict`, `slot_taken`, `hold_exists` | The state does not allow it, or an idempotency key was reused with a different body | Re-read the state; do not retry blindly |
| 413 | `payload_too_large` | Body over the limit | Send less |
| 415 | `unsupported_media_type` | Not JSON, form or multipart | Set `Content-Type: application/json` |
| 422 | `validation_failed`, and portal codes such as `booking_rejected`, `verification_refused` | Invalid input, or a business rule | Read `details`; fix and resend |
| 429 | `rate_limited` | Over a limit | Wait `Retry-After` seconds |
| 500 | `server_error` | Something unexpected failed; the message is generic | Retry with back-off; quote `request_id` if it persists |
| 503 | `service_unavailable` | Maintenance or an unavailable dependency | Retry after `Retry-After` when present |

### Which errors to retry

* **Retry** (with exponential back-off and jitter, and the same `Idempotency-Key`): `429`, `500`, `503`, and network errors where you do not know whether the call arrived.
* **Refresh and retry once**: `401 invalid_token`.
* **Never retry unchanged**: other `4xx`. The same request will fail the same way.

## Idempotency

Networks drop answers. If a `POST` that creates a booking times out, you do not know whether the booking exists. Sending it again could book twice.

Send an `Idempotency-Key` header with every `POST` that creates something:

```bash
curl -X POST "$BASE/practical-training/bookings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: 3f1a6e2c-8d0b-4f0f-9a4e-5d7a2b1c9e10" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

| You send | You get |
| --- | --- |
| The key for the first time | The call is made and its answer is stored |
| The **same key and the same body** within 24 hours | The **first answer again**, with the header `Idempotent-Replayed: true`, and nothing is made twice |
| The **same key and a different body** | `409 idempotency_conflict` |

Rules of thumb:

* Use a **uuid per logical action** (one per booking you intend to make), not per attempt. Keep it with the action so a retry after a restart reuses it.
* Keys are remembered for **24 hours**.
* `POST /webhooks` (create an endpoint) does **not** take an idempotency key: repeating it creates a second endpoint. List your endpoints before you retry after a lost answer.
* Webhook deliveries have their own deduplication key: the `event_id` of the body.

## Related

* [Request log and debugging](hb://guides/portal-request-log-and-debugging)
* [Webhooks](hb://guides/portal-webhooks)
* [API keys and token exchange](hb://guides/portal-api-keys-and-tokens)
