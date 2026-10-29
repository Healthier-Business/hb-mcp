# Training Verification API v2

Base URL: `https://hub.hbcompliance.co.uk/api/v2/training-verification/`. Portal key `training-verification`. Every operation is described in full (parameters, body, answers, errors) by `hb_describe_operation`.

Training Verification checks a training certificate against what Healthier Business holds. A client sends a certificate (a PDF or an image) with the candidate's name and email and the agency named on it; Hub reads it and matches the candidate (`auto`) or passes it to Healthier Business staff (`manual`), and tells you the outcome by email, by webhook and through this API. This API does what the Hub form does, with the same rules, prices, file types and size limit.

## 1. How it works

* **Authentication.** `POST /api/v2/auth/token` with the API key returns an `access_token`; send it as `Authorization: Bearer <access_token>`. A client with no Training Verification account gets `403 portal_unavailable` on every call.
* **A verification is addressed by its integer `id`.** A candidate is linked, optionally, by `candidate_ref`, the uuid of the Hub core API (`/api/v2/hub/candidates`); it must be one of your candidates (`422` on `candidate_ref` otherwise). Another client's verification is `404 not_found`, never `403`.
* **Asynchronous.** `POST /verifications` answers `202 Accepted` with the verification in `pending`. The check runs afterwards; you learn the outcome from a webhook (section 7) or by reading the verification. A manual request stays `processing` until staff decide.
* **Dates** are ISO 8601 UTC with `Z`. The dates of the courses found (`completed_on`, `expires_on`) are UK dates, `YYYY-MM-DD`. Money is integer pence with `currency: "GBP"`.
* **Response shapes** are those of every v2 portal: `{ "data": {...} }`, lists as `{ "data": [...], "meta": {...}, "links": {...} }` with `page` and `per_page` (default 25, at most 100), errors as `{ "error", "message", "details"?, "request_id" }`.
* **Rate limits.** The key's hourly limit (1000 calls an hour by default, shared by every token of the key) is the only limit; every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. The portal has no limit of its own.

## 2. Scopes

| Scope | Endpoints |
| --- | --- |
| `training-verification:read` | every `GET`: `profile`, `pricing`, `credits`, `credits/transactions`, `verifications`, `verifications/{verification}`, `.../events`, `.../certificate`, `.../report` |
| `training-verification:write` | `POST verifications`, `POST verifications/{verification}/cancel`; it also grants `training-verification:read` |

`training-verification:*` covers the portal and `*` covers everything. The Developer page lists both scopes with the other portals; no change to the key screen was needed.

## 3. Endpoints

| Method and path | Operation id | Scope |
| --- | --- | --- |
| `GET /profile` | `training-verification.profile.show` | read |
| `GET /pricing` | `training-verification.pricing.show` | read |
| `GET /credits` | `training-verification.credits.show` | read |
| `GET /credits/transactions` | `training-verification.credits.transactions` | read |
| `POST /verifications` (202, `Idempotency-Key`) | `training-verification.verifications.create` | write |
| `GET /verifications` | `training-verification.verifications.list` | read |
| `GET /verifications/{verification}` | `training-verification.verifications.show` | read |
| `GET /verifications/{verification}/events` | `training-verification.verifications.events` | read |
| `GET /verifications/{verification}/certificate` | `training-verification.verifications.certificate` | read |
| `GET /verifications/{verification}/report` | `training-verification.verifications.report` | read |
| `POST /verifications/{verification}/cancel` | `training-verification.verifications.cancel` | write |

### GET /profile

The account, read from the account record: `client_type` (`regular` or `verification_only`), `verify_only`, `request_types` (each with `free`, `net_pence`, `vat_pence`, `gross_pence` and a `reason`), `limits` (`max_certificate_kb`, `certificate_types`, `max_client_reference_length`), `default_notify_email` and `payment` (`methods`, `card: false`).

```json
{ "data": { "id": 1001, "name": "Acme Agency", "client_type": "regular", "verify_only": false,
  "request_types": [
    { "request_type": "auto", "free": true, "net_pence": 0, "vat_pence": 0, "gross_pence": 0, "currency": "GBP",
      "reason": { "code": "included_with_other_services", "message": "Automated verification is included with your other Hub services." } },
    { "request_type": "manual", "free": false, "net_pence": 1000, "vat_pence": 200, "gross_pence": 1200, "currency": "GBP",
      "reason": { "code": "manual_verification_charged", "message": "Manual verification is charged on every account, at your price for the request type." } } ],
  "limits": { "max_certificate_kb": 5120, "certificate_types": ["pdf", "jpg", "jpeg", "png"], "max_client_reference_length": 100 },
  "default_notify_email": "verifications@example.com",
  "payment": { "methods": ["credit", "legacy_balance", "balance"], "card": false } } }
```

### GET /pricing

The same quotes plus `client_type`, `vat_rate_percent` and `funding_order` (the order a charge is taken from your credits and balances). See section 5.

### GET /credits and GET /credits/transactions

`GET /credits`: `money_pence`, `auto_credits` (verification-only accounts; null otherwise), `manual_credits`, `legacy_balance_pence` (null when the account has none and is not verification-only), `currency`. The API cannot top up: that is paid for in Hub.

`GET /credits/transactions`: newest first; filters `ledger` (`money`, `auto_credits`, `manual_credits`, `legacy_balance`; without it the money and credit ledgers together) and `created_from` / `created_to` (UTC days). Each row: `id`, `ledger`, `created_at`, `description`, `amount` (always positive; pence for `money` and `legacy_balance`, a count for the credit ledgers), `unit`, `is_credit` (added, or spent) and `candidate_name`.

### POST /verifications

Fields: `request_type` (`auto` or `manual`), `candidate_name`, `candidate_email`, `agency_name_on_cert`, the certificate, and optionally `notify_email`, `candidate_ref` and `client_reference`.

* `notify_email`: where the result email goes. It defaults to the account's first verification notification address (`default_notify_email`); with none, it is required. The result email still goes out, as for a Hub submission.
* `candidate_ref`: links one of your Hub candidates. Validated; returned as `candidate_ref`.
* `client_reference`: your own string, at most 100 characters, not required to be unique. Stored, returned on the verification, filterable (`client_reference=`) and included in every webhook.
* The certificate is **either** a file or base64, with the same types (`pdf`, `jpg`, `jpeg`, `png`) and size limit as the Hub form (5120 kilobytes by default, `limits.max_certificate_kb`). The API never fetches a URL.

Multipart upload:

```
curl -X POST "$HUB_BASE_URL/api/v2/training-verification/verifications" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Idempotency-Key: placement-2291-cert-1" \
  -F request_type=auto -F candidate_name="Jo Smith" -F candidate_email=jo.smith@example.com \
  -F agency_name_on_cert="Healthy Staffing Ltd" -F notify_email=hr@example.com \
  -F candidate_ref=9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f -F client_reference=PLACEMENT-2291 \
  -F certificate=@jo-smith-certificate.pdf
```

JSON with base64 (a `data:...;base64,` prefix is accepted; `certificate_filename` must carry the extension):

```
curl -X POST "$HUB_BASE_URL/api/v2/training-verification/verifications" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: placement-2291-cert-1" \
  -d '{"request_type":"auto","candidate_name":"Jo Smith","candidate_email":"jo.smith@example.com",
       "agency_name_on_cert":"Healthy Staffing Ltd","notify_email":"hr@example.com","client_reference":"PLACEMENT-2291",
       "certificate_base64":"JVBERi0xLjQK...","certificate_filename":"jo-smith-certificate.pdf"}'
```

Answer `202`, with a `Location` header: the verification, `status` `pending`, `charge` (what it cost), `result` null. A wrong file type, an oversize file, bad base64, a missing field or a `candidate_ref` that is not yours is `422 validation_failed` with the field in `details` (`certificate`, `certificate_base64`, `certificate_filename`, `candidate_name`, ...). Nothing is stored when a call is refused.

### GET /verifications

Filters: `status` (one or several: `status[]=verified&status[]=failed`), `request_type`, `candidate_ref`, `client_reference` (exact), `created_from` and `created_to` (UTC days). `sort`: `created_at` (default, latest first), `status`, `id`; `-` for descending. It lists every verification of the account, including those made in Hub (their `client_reference` is null). `result.records` is null in lists; read one verification for the courses.

### GET /verifications/{verification}

The verification in full, including `result.records` once `verified`.

```json
{ "data": { "id": 4821, "client_reference": "PLACEMENT-2291", "request_type": "auto", "status": "verified",
  "candidate_name": "Jo Smith", "candidate_email": "jo.smith@example.com", "agency_name_on_cert": "Healthy Staffing Ltd",
  "notify_email": "hr@example.com", "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "result": { "matched": true, "provider": "Healthy Staffing Ltd",
    "records": [ { "title": "Fire Safety", "completed_on": "2026-02-01", "expires_on": "2027-02-01", "type": "e-learning" },
                 { "title": "Moving and Handling (Practical)", "completed_on": "2026-03-01", "expires_on": "2027-03-01", "type": "practical" } ],
    "reason": null },
  "charge": { "free": true, "funding": "free", "amount_pence": 0, "credits_used": 0, "currency": "GBP", "refunded": false },
  "created_at": "2026-10-28T19:53:24Z", "updated_at": "2026-10-28T19:58:02Z", "completed_at": "2026-10-28T19:58:02Z", "certificate_available": true } }
```

### GET /verifications/{verification}/events

The timeline, oldest first, under public names: `submitted`, `processing_started`, `sent_for_manual_review`, `verified`, `not_found`, `failed`, `rejected`, `refunded` (`amount_pence`), `retried` (a stall recovery or a staff re-run), `completion_email_sent`, `result_email_resent`. `not_found`, `failed` and `rejected` carry `reason_code`. Internal steps (reading the certificate, matching, staff opening the file) are never listed.

### GET /verifications/{verification}/certificate

Streams the file you submitted as an attachment (`application/pdf`, `image/jpeg` or `image/png`), never cached. Each download is written to the verification's internal timeline as `certificate_viewed`. A file that is no longer held, or a verification made in Hub before the API existed whose file is a legacy link, is `410 certificate_unavailable` (`certificate_available` says so beforehand). There is no signed URL: the call itself needs the bearer token.

### GET /verifications/{verification}/report

The verification report as a PDF (candidate, agency, dates and the courses found), once `verified`; before that, or for a `not_found`, `rejected` or `failed` verification, `409 report_not_available`.

### POST /verifications/{verification}/cancel

Only while `pending`. The verification becomes `rejected` with the reason code `cancelled_by_client`, no email is sent, and a charge is refunded to where it came from (a credit back to its ledger, money to the money balance, the older balance restored): `charge.refunded` is true and the webhooks `training-verification.rejected` and `training-verification.refunded` fire. A free request has nothing to refund. In any other status: `409 not_cancellable`. If the refund itself failed, the cancellation stands and Healthier Business completes the refund (`charge.refunded` stays false).

## 4. Statuses and the result

| `status` | Hub status | Meaning |
| --- | --- | --- |
| `pending` | Pending | Accepted, not started. Can be cancelled. |
| `processing` | Processing | An automated check is running, or a manual request is with staff. |
| `verified` | Sent, Verified, Completed | The certificate was verified. **`Sent`**: the automatic check matched the candidate and the result email was sent. **`Verified`**: staff marked it verified (a manual outcome). **`Completed`**: a TDTA certificate was confirmed against the practical training bookings. |
| `not_found` | Not Found | The agency or candidate could not be matched, several matched, or the candidate has no completed courses. |
| `rejected` | Rejected | Rejected by staff, or cancelled by you. |
| `failed` | Failed | The automated check failed for a system reason. |

`verified`, `not_found`, `rejected` and `failed` are final unless staff re-run the verification, which sends its own new events.

`result` is null until the status is final. Then: `matched` (true only for `verified`), `provider` (the agency whose training was found), `records` (on `GET /verifications/{verification}`: `title`, `completed_on`, `expires_on` UK dates, `type` `e-learning` or `practical`; the same facts as the result email, read when you ask), and `reason` for `not_found`, `rejected`, `failed`: a stable `code` and a fixed `message`.

Reason codes: `file_unreadable`, `agency_not_found`, `candidate_not_found`, `ambiguous_candidate`, `ambiguous_agency`, `no_courses`, `tdta_not_found`, `tdta_not_passed`, `system_error`, `staff_rejected`, `cancelled_by_client`, `other`. Staff and engine comments are never returned.

`candidate_ref` on a verification is the one you sent; otherwise it is set only when a candidate of your own account was matched. A candidate of another account (the agency named on the certificate) is never exposed.

## 5. Pricing and credits

The API charges your **credits and balances only**; there is no card payment through the API. The rules are those of the Hub form (`Pricing::quote` and `SubmissionService`), read from the account record, never from anything the caller sends.

### Who pays for what

| | Auto | Manual |
| --- | --- | --- |
| **Regular account** (uses other Hub services) | **Free.** Works with a zero balance, takes nothing, writes no ledger entry. Reason `included_with_other_services`. | **Charged**: the account's manual price, else the standard manual price (10 pounds net by default), plus VAT from the money balance. Reason `manual_verification_charged`. |
| **Verification-only account** | **Charged**: the account's automated price, else the standard automated price (5 pounds net by default). Reason `verification_only_account`. | **Charged**: the manual price as above. Reason `verification_only_account`. |

A charge is taken once, from the first of these that covers it: one verification credit of that request type (verification-only accounts), the older pounds balance (the net price), the money balance (net plus VAT). When none covers it the answer is `402 insufficient_credits` and nothing is stored or charged:

```json
{ "error": "insufficient_credits", "message": "The account does not hold enough credits or balance for this verification.",
  "details": { "required": { "gross_pence": 1200, "net_pence": 1000, "credits": 0 },
               "available": { "money_pence": 300, "legacy_balance_pence": 0, "credits": 0 } }, "request_id": "..." }
```

Top-ups and credit purchases are made in Hub. A retry with the same `Idempotency-Key` never charges twice; a cancel refunds a charge once.

## 6. Errors

| HTTP | `error` | When |
| --- | --- | --- |
| 401 | `unauthenticated`, `invalid_token` | no, unknown or expired bearer token |
| 403 | `insufficient_scope`, `key_inactive`, `ip_not_allowed`, `portal_unavailable` | key problems; the account has no Training Verification |
| 402 | `insufficient_credits` | a charged request the credits and balances cannot pay (`details.required`, `details.available`) |
| 404 | `not_found` | unknown or another client's verification, unknown route |
| 409 | `idempotency_conflict` | the `Idempotency-Key` was used with a different body |
| 409 | `not_cancellable` | cancel when the verification is not `pending` |
| 409 | `report_not_available` | report of a verification that is not `verified` |
| 409 | `submission_in_progress`, `submission_failed`, `account_user_missing` | the submission could not be completed; retry with the same key, or contact support |
| 410 | `certificate_unavailable` | the certificate file is no longer held |
| 413, 415 | `payload_too_large`, `unsupported_media_type` | the request body is too large for the server, or not JSON or multipart (a certificate over the Hub limit, or of the wrong type, is `422` on `certificate`) |
| 422 | `validation_failed` | invalid input; `details` is `{ field: [messages] }` |
| 429 | `rate_limited` | over the key's hourly limit (`Retry-After`) |

## 7. Webhooks

Seven events, picked per endpoint like every Hub event (`GET /api/v2/webhooks/events`, `POST /api/v2/webhooks`), signed and retried like every portal (`X-Hub-Signature`, five attempts, the delivery log). They are queued from the one place the verification timeline is written, so a real state change fires **exactly one** event per endpoint subscribed, and an engine retry, a stall recovery, a staff re-run or a repeated step never sends the same event twice (each event name fires at most once per verification). The body is the standard envelope; `data` carries ids, statuses, a public `reason_code`, timestamps and the candidate name you supplied. It never carries the certificate, the courses found, the candidate's email address or staff comments.

| Event | Fires |
| --- | --- |
| `training-verification.submitted` | the verification was created (API or Hub), `status` `pending` |
| `training-verification.processing` | the check started (a manual request: when passed to staff) |
| `training-verification.verified` | `verified` (Sent, Verified or Completed) |
| `training-verification.not_found` | `not_found`, with `reason_code` |
| `training-verification.rejected` | rejected by staff or cancelled by you, with `reason_code` |
| `training-verification.failed` | `failed`, `reason_code` `system_error` |
| `training-verification.refunded` | a charge was refunded, with `refund.amount_pence` |

Common `data` fields: `verification_id`, `client_reference`, `request_type`, `status`, `candidate_ref`, `candidate_name`, `created_at`, `updated_at`. Added by event: `completed_at` (`verified`), `reason_code` (`not_found`, `rejected`, `failed`), `refund` (`refunded`).

```json
{ "event_id": "0d3b8f0e-6c1a-4f43-9d5e-2b7a1c9e4a10", "event_type": "training-verification.verified", "occurred_at": "2026-10-28T19:58:02Z",
  "data": { "verification_id": 4821, "client_reference": "PLACEMENT-2291", "request_type": "auto", "status": "verified",
            "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", "candidate_name": "Jo Smith",
            "created_at": "2026-10-28T19:53:24Z", "updated_at": "2026-10-28T19:58:02Z", "completed_at": "2026-10-28T19:58:02Z" } }
```

```json
{ "event_id": "7a2c1e90-3b4d-4e8f-a1b2-c3d4e5f60718", "event_type": "training-verification.not_found", "occurred_at": "2026-10-28T19:54:09Z",
  "data": { "verification_id": 4822, "client_reference": null, "request_type": "auto", "status": "not_found",
            "candidate_ref": null, "candidate_name": "Sam Jones", "reason_code": "candidate_not_found",
            "created_at": "2026-10-28T19:53:24Z", "updated_at": "2026-10-28T19:54:09Z" } }
```

```json
{ "event_id": "c1f0a9b8-7d6e-4c5b-8a4f-3e2d1c0b9a87", "event_type": "training-verification.refunded", "occurred_at": "2026-10-28T20:15:00Z",
  "data": { "verification_id": 4830, "client_reference": "PLACEMENT-2300", "request_type": "manual", "status": "rejected",
            "candidate_ref": null, "candidate_name": "Ann Lee", "created_at": "2026-10-28T19:50:00Z", "updated_at": "2026-10-28T20:15:00Z",
            "refund": { "amount_pence": 1200, "currency": "GBP", "refunded_at": "2026-10-28T20:15:00Z" } } }
```

`submitted`, `processing` and `rejected` have the same shape (`status` `pending`, `processing`, `rejected`; `rejected` and `failed` add `reason_code`). Every event has its payload schema and sample (`hb_describe_event`). `POST /api/v2/webhooks/{webhook}/test` sends `webhook.test` to an endpoint that subscribes to them, as for any portal.

## 8. Idempotency

`POST /verifications` takes an `Idempotency-Key` header (the Hub form's `submission_token`). The same key and body within 24 hours returns the first answer with `Idempotent-Replayed: true` and creates and charges nothing more; the same key with a different body is `409 idempotency_conflict`; only a success is remembered. After the 24 hours the key still maps to the same Hub submission, so a very late retry returns the existing verification and never charges twice. Send a new key for a new verification, and the same key for retries of one.

## 9. Privacy and retention

A certificate carries personal data (the candidate's name and training record). It is returned only to the client that submitted it, over the bearer-authenticated API, never in a webhook, and its opening is recorded on the verification's internal timeline. Result details (the courses found) are read live from Hub when you ask and are not in webhooks or lists. Retention follows the Hub's existing rule: Hub has no automatic purge of certificate files or result emails today (a retention period is still to be decided), so files are kept until Healthier Business removes them; to have one erased, contact support. Store the copies you download only as long as you need them.

## 10. FAQ

* **Is automated verification free for us?** If your account also uses other Hub services (it is `regular`), yes, through the API and the form. If the account only uses Training Verification, it is charged. `GET /pricing` and `GET /profile` say which, with the reason.
* **Can I pay by card through the API?** No. Top up in Hub; a shortfall is `402 insufficient_credits`.
* **Why is `result.records` null?** Lists and the 202 answer leave it out; read one verification once it is `verified`.
* **Why no `candidate_ref` on a verified result?** You did not send one and the candidate found belongs to another account. Send `candidate_ref` at creation to link your own candidate.
* **Can I send a URL to the certificate?** No: upload the file or send base64.
* **How do I know a manual request is done?** `training-verification.verified`, `.rejected` or `.not_found`, or poll the verification.
