# Clinical Appraisals API v2: reference

This is the contract of the Clinical Appraisals API. The full, machine readable description of every operation, field and webhook event is `docs/developers/openapi/hub-v2.json` (written from the controllers, resources and `docs/developers/openapi/overrides/clinical-appraisals*.json`, and linted by `php artisan api:docs:lint --portal=clinical-appraisals`); this page explains how the calls fit together and gives a complete worked example.

Base URL: `https://hub.hbcompliance.co.uk/api/v2/clinical-appraisals/`. Portal key `clinical-appraisals`. Every call needs `Authorization: Bearer <access_token>` (from `POST /auth/token` with the API key) and `Accept: application/json`. The client must have a Clinical Appraisals account, otherwise every call is `403 portal_unavailable`. Everything is scoped to the key's client. Calls are rate limited per key (`429 rate_limited` with `Retry-After`).

An appraisal has no time slot to hold: you book it, the candidate completes the documentation and books a slot afterwards. For that reason this API has no timeslot, reschedule or cancel call: `start_date` and `end_date` of a booking stay null until the candidate has chosen a slot, and the stages after the booking (`docs_submitted`, `slot_booked`, `in_progress`, `evaluation_submitted`, `report_ready`, `completed`) are read from `appraisal_status` of `GET /bookings`.

## 1. Conventions

* A single resource is `{ "data": { ... } }`. A list is `{ "data": [ ... ], "meta": { "page", "per_page", "total", "last_page", "from", "to" }, "links": { "first", "last", "prev", "next" } }`. Appraisal types are a short fixed list: one page that holds every item.
* Errors are `{ "error": "<code>", "message": "...", "details": { "field": ["message"] }, "request_id": "..." }`; `details` only on `validation_failed`. Codes: `invalid_token` 401, `insufficient_scope` 403, `portal_unavailable` 403, `not_found` 404, `idempotency_conflict` 409, `validation_failed` 422, `booking_refused` 422, `report_not_available` 422, `rate_limited` 429.
* Another client's record is always `404 not_found`, never `403`.
* Pagination: `page` (default 1) and `per_page` (default 25, 1 to 100; more is `422 validation_failed`).
* Dates and times: ISO 8601 UTC with `Z`. Query dates are `YYYY-MM-DD`.
* Money: integer pence in fields ending `_pence`, with a `currency: "GBP"` field beside it. Credits are whole units (numbers, not pence).
* Candidate: always the `candidate_ref` (uuid), the same value as in the Hub core API (`/api/v2/hub/candidates`). There is no integer candidate id. Create the person first with `POST /api/v2/hub/candidates`.
* `Idempotency-Key` on `POST /bookings`: the same key and body within 24 hours returns the original answer with `Idempotent-Replayed: true`; the same key with a different body is `409 idempotency_conflict`.
* Ids are integers.

## 2. Scopes

| Scope | Endpoints |
| --- | --- |
| `clinical-appraisals:account:read` | `GET /profile` |
| `clinical-appraisals:credits:read` | `GET /credits`, `GET /credits/transactions` |
| `clinical-appraisals:catalogue:read` | `GET /appraisal-types` |
| `clinical-appraisals:bookings:read` | `GET /bookings`, `GET /bookings/{id}`, `GET /bookings/{id}/evaluation-report` |
| `clinical-appraisals:bookings:write` | `POST /bookings` |

`clinical-appraisals:*` and `*` cover all. A `:write` scope does not include its `:read` scope: give both. Missing scope: `403 insufficient_scope`.

## 3. Endpoints

`GET /profile`: `id` (the Hub client id), `name`, `contact_name`, `email`, `notify_email`, `client_active`.

`GET /credits`: `booking_credits` (list of `appraisal_type_id`, `appraisal_type_name`, `credits`), `booking_money_balance_pence`, `currency`.

`GET /credits/transactions`. Query: `wallet` (an appraisal type id or `booking_balance`), `type` (`deposit` or `withdraw`), `created_from`, `created_to`, `page`, `per_page`. Rows: `id`, `type`, `confirmed`, `wallet`, `is_money`, `amount` (credits; null for money), `amount_pence` and `currency` (money; null for credits), `created_at`.

`GET /appraisal-types`: `id`, `name`, `description`, `price_inc_vat_pence`, `client_rate_pence`, `currency`.

`GET /bookings`. Query: `status` (booking status such as `pending`, `booked` or `cancelled`, one or many; a value that matches nothing gives an empty page), `appraisal_status` (one or many of `pending_docs`, `docs_submitted`, `slot_booked`, `in_progress`, `evaluation_submitted`, `report_ready`, `completed`, `cancelled`), `appraisal_type_id`, `candidate_ref`, `created_from`, `created_to`, `search` (name or email), `page`, `per_page`. A `candidate_ref` that is not one of the client's candidates is `422 validation_failed` on `candidate_ref`. Abandoned bookings are not listed.

Booking fields: `id`, `candidate_ref` (null for an older booking whose person is not a Hub candidate), `candidate_name`, `candidate_email`, `candidate_phone`, `job_role`, `nmc_number`, `appraisal_type` (`id`, `name`), `appraiser` (`id`, `name` or null), `start_date`, `end_date` (null until the candidate books a slot), `appraisal_status`, `appraisal_status_label`, `booking_status`, `pay_status`, `pay_option`, `paid_by` (`agency` or `candidate`), `booked_by`, `evaluation_report_available`, `created_at`.

How a booking gets its `candidate_ref`: a booking made through this API belongs to the Hub candidate; a booking without that link is matched to the client's Hub candidate with the same email, else `candidate_ref` is null.

`GET /bookings/{id}`: the booking. `GET /bookings/{id}/evaluation-report`: the PDF (`appraisal-evaluation-{id}.pdf`); `422 report_not_available` before the evaluation has been submitted (`evaluation_report_available` is true from `appraisal_status` `evaluation_submitted`). The report is a sensitive personal record of the candidate: do not log it. There is no webhook for it; read `appraisal_status`.

`POST /bookings` (`bookings:write`, `Idempotency-Key`). Body:

| Field | Rule |
| --- | --- |
| `appraisal_type_id` | required, integer, one of `GET /appraisal-types` |
| `candidate_ref` | required, uuid of one of the client's Hub candidates (`422` on `candidate_ref` otherwise, never 404). The name, email and phone come from the Hub candidate; a candidate with no name, email or phone gets `422` on `candidate_ref` |
| `phone` | optional, used when the Hub candidate has none |
| `job_role`, `nmc_number` | optional |
| `pay_option` | required: `credits`, `balance`, `invoice` (or `inv`), or `candidate_pays` (the candidate is emailed a payment link) |
| `agency_contact_name`, `agency_contact_email` | required |
| `agency_email` | optional (default: the account's notification email) |
| `video_call_awareness`, `photo_id_awareness` | required, must be true |

`201` with the booking, `appraisal_status` `pending_docs`. With `credits`, `balance` or `invoice` it is confirmed and paid at once: one credit of the type is taken, or the price is taken from the booking money balance, or nothing is taken now and the appraisal is invoiced. The candidate is emailed a request to complete the documentation, the agency contact is told the booking is awaiting the candidate, and the webhook `booking.created` is sent. With `candidate_pays` the booking is `pending` with `paid_by` `candidate`, nothing is taken from your account, the candidate is emailed a payment link, and the data also has `payment_url` (only in this answer); `booking.created` is sent at once and `booking.confirmed` when the candidate pays. Refused (no credit, balance too low, option not available, unknown or inactive type): `422 booking_refused`, never `402`. A retry without an `Idempotency-Key` books and charges again. A login on the appraisals portal is created for the candidate's and the agency's email addresses when they have none; its password is a random value nobody knows (never the email address), and the person reaches the portal through the signed links in the booking emails or the portal's password reset.

## 4. Webhooks

Delivery, signature headers and retries are those of Hub webhooks (`/api/v2/webhooks`): each delivery has the headers `X-Hub-Signature`, `X-Hub-Timestamp`, `X-Hub-Event`, `X-Hub-Event-Id` and `X-Hub-Delivery-Id`, and a failed delivery is retried. Body: `event_id`, `event_type`, `occurred_at`, `data`. Event names are prefixed `clinical-appraisals.`. `data` carries ids, the `candidate_ref`, the appraisal type and statuses; it never carries the candidate's name, email or phone.

| Event | When | `data` fields |
| --- | --- | --- |
| `booking.created` | an appraisal was booked and needs no payment from you now (credits, balance, invoice, or left to the candidate to pay): `POST /bookings`, or a booking made in Hub | `booking_id`, `candidate_ref`, `appraisal_type` (`id`, `name`), `status` (booking status), `appraisal_status`, `pay_option`, `by` |
| `booking.confirmed` | a card payment confirmed the booking (usually the candidate paying the link of a `candidate_pays` booking); never for credits, balance or invoice | `booking_id`, `candidate_ref`, `appraisal_type`, `status`, `appraisal_status`, `pay_status`, `transaction_id`, `by` |
| `webhook.test` | the test button | `message` |

`candidate_ref` is null when the booking's person is not a Hub candidate. `by` is the fixed value `agency` on both events. For a booking made through the API, `candidate_ref` in `booking.created` is the `candidate_ref` you sent: the booking is linked to the Hub candidate as it is created, and the event is built with that ref, never looked up by email address. `booking_id` identifies the booking.

Example (`booking.created`):

```json
{ "event_type": "clinical-appraisals.booking.created", "data": { "booking_id": 55, "candidate_ref": "9f1c...", "appraisal_type": { "id": 2, "name": "Clinical Appraisal" }, "status": "booked", "appraisal_status": "pending_docs", "pay_option": "credits", "by": "agency" } }
```

Only `booking.created` and `booking.confirmed` are sent (plus `webhook.test`). Cancellation, completion, documents submitted, slot booked and report ready are **not** sent as webhook events. Not offered yet: cancelled and completed events. Clinical Appraisals cancels a booking only when an unpaid one goes stale, and records completion in several places, so there is no single point to send them from; they are deferred.

## 5. Worked example: find the type, book, follow, read the report

The calls below use the made up ids and addresses of the OpenAPI examples. Every call carries `Authorization: Bearer <access_token>` and `Accept: application/json`. The candidate already exists in Hub (`POST /api/v2/hub/candidates` gave `candidate_ref` `9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f`, with a name, an email address and a phone number).

**1. Find the appraisal type.** `GET /appraisal-types` (scope `catalogue:read`):

```json
{ "data": [
  { "id": 2, "name": "Clinical Appraisal", "description": "Annual clinical appraisal for registered nurses, held as a video call.", "price_inc_vat_pence": 15000, "client_rate_pence": 12500, "currency": "GBP" }
], "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 }, "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/clinical-appraisals/appraisal-types?page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/clinical-appraisals/appraisal-types?page=1", "prev": null, "next": null } }
```

**2. Check what you can pay with.** `GET /credits` (scope `credits:read`) shows `booking_credits` for type 2 and the money balance:

```json
{ "data": { "booking_credits": [ { "appraisal_type_id": 2, "appraisal_type_name": "Clinical Appraisal", "credits": 3 } ], "booking_money_balance_pence": 25000, "currency": "GBP" } }
```

**3. Book it.** There is no slot to hold. `POST /bookings` with `Idempotency-Key: 3c9d0e7a-5b41-4f2e-8a16-d4e7b0c92f58` (scope `bookings:write`):

```json
{
  "appraisal_type_id": 2,
  "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "job_role": "Registered Nurse",
  "nmc_number": "12A3456E",
  "pay_option": "credits",
  "agency_contact_name": "Alex Morgan",
  "agency_contact_email": "alex.morgan@northgate.example",
  "video_call_awareness": true,
  "photo_id_awareness": true
}
```

Answer `201`. One credit of type 2 was taken. The candidate is emailed a request to complete the documentation and books a slot afterwards, so `start_date` is null:

```json
{ "data": {
  "id": 55, "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", "candidate_name": "Jane Smith", "candidate_email": "jane.smith@example.com", "candidate_phone": "07700 900123",
  "job_role": "Registered Nurse", "nmc_number": "12A3456E", "appraisal_type": { "id": 2, "name": "Clinical Appraisal" }, "appraiser": null,
  "start_date": null, "end_date": null, "appraisal_status": "pending_docs", "appraisal_status_label": "Awaiting documents",
  "booking_status": "booked", "pay_status": "completed", "pay_option": "credits", "paid_by": "agency", "booked_by": "Agency",
  "evaluation_report_available": false, "created_at": "2026-10-28T09:15:40Z"
} }
```

To leave the payment to the candidate, send `"pay_option": "candidate_pays"` instead. The booking is then `pending` with `pay_option` `cc` and `paid_by` `candidate`, nothing is taken from your account, and the answer has one more field, which is not repeated by any later call:

```json
{ "data": { "id": 56, "booking_status": "pending", "pay_status": "pending", "pay_option": "cc", "paid_by": "candidate", "payment_url": "https://appraisals.hbcompliance.co.uk/candidate-payment/8r0drEVYlp", "...": "the other booking fields as above" } }
```

A missing confirmation, such as `video_call_awareness` left out or false, is `422`:

```json
{ "error": "validation_failed", "message": "You must confirm the candidate is aware of the video call format.", "details": { "video_call_awareness": ["You must confirm the candidate is aware of the video call format."] }, "request_id": "01M6X4Q9T2R7B8C1D3E5F6G7H8" }
```

**4. The webhook.** Every endpoint of the account that picked `clinical-appraisals.booking.created` receives (the signature headers are described in `/api/v2/webhooks`):

```json
{
  "event_id": "2a9b5c71-6d3e-4f08-b1a4-8c7e0d5f3a92",
  "event_type": "clinical-appraisals.booking.created",
  "occurred_at": "2026-10-28T09:15:41Z",
  "data": {
    "booking_id": 55, "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", "appraisal_type": { "id": 2, "name": "Clinical Appraisal" },
    "status": "booked", "appraisal_status": "pending_docs", "pay_option": "credits", "by": "agency"
  }
}
```

For a `candidate_pays` booking the same event is sent at once (`status` `pending`, `pay_option` `cc`), and `clinical-appraisals.booking.confirmed` follows when the candidate has paid, with `pay_status` `completed` and a `transaction_id`. No other event is sent for this booking.

**5. Follow it.** There is no reschedule or cancel call, and no further webhook. When the candidate has completed the documentation and chosen a slot, `GET /bookings/55` shows it: `appraisal_status` `slot_booked`, `appraisal_status_label` `Slot booked`, `start_date` `2026-11-03T10:00:00Z`, `end_date` `2026-11-03T11:00:00Z` and an `appraiser` (`{ "id": 12, "name": "Helen Carter" }`). To find the appraisals that need attention, list them by stage: `GET /bookings?appraisal_status[]=evaluation_submitted&appraisal_status[]=report_ready`.

**6. Read the report.** From `evaluation_submitted` onwards `evaluation_report_available` is true and `GET /bookings/55/evaluation-report` (scope `bookings:read`) returns the PDF (`Content-Type: application/pdf`, `Content-Disposition: attachment; filename="appraisal-evaluation-55.pdf"`). Before then:

```json
{ "error": "report_not_available", "message": "The evaluation report is not available yet.", "request_id": "01M6X4Q9T2R7B8C1D3E5F6G7H9" }
```

The report is a sensitive personal record of the candidate: do not log it and keep it only as long as you need it.

## 6. v1 to v2

| v1 | v2 |
| --- | --- |
| `GET /transactions`, `GET /credits` under scope `account:read` | `GET /credits/transactions`, `GET /credits` under scope `credits:read` |
| bare object for one resource | `{ "data": {...} }` |
| list `meta.current_page`, `last_page`; default 20 | `meta.page`, `per_page`, `total`, `last_page`; default 25 |
| booking `candidate` object | `candidate_ref`, `candidate_name`, `candidate_email`, `candidate_phone`, `job_role`, `nmc_number` |
| `POST /bookings` with `first_name`, `last_name`, `email`, `phone` | `candidate_ref` (and optional `phone`) |
| `appraisal_type_id` or `course_id` | `appraisal_type_id` only |
| `date_from`, `date_to` (booking created day) | `created_from`, `created_to` |
| times with `+00:00` | UTC with `Z` |
| `cost_inc_vat`, `client_rate` (pounds) | `price_inc_vat_pence`, `client_rate_pence`, `currency` |
| `booking_money_balance` (pounds) | `booking_money_balance_pence`, `currency` |
| credits `course_id`, `course_name` | `appraisal_type_id`, `appraisal_type_name` |
| transaction `amount` (money in pence), `meta` | `amount_pence` + `currency` (money) or `amount` (credits); `meta` is not returned |
| errors `{ message }` | `{ error, message, details? }` (snake_case codes) |
| webhook `data.booking` (whole booking with candidate details), `candidate_name` | `candidate_ref`, no personal data |
| no `Idempotency-Key` | `Idempotency-Key` on `POST /bookings` |
| `GET /booking-url` (always `{"booking_url": null}`), `GET /timeslots` (always empty), `POST /timeslots/hold` (always `422`), `DELETE /timeslots/hold/{holdHash}` (always `404`) | **retired (deprecated, 29 Oct 2026)**: stubs from the old API, no replacement, an appraisal has no timeslot or hold in Hub. They still answer until removal is scheduled (retire list in `../data/v1-v2-gap-audit.md`) |
| `POST /bookings` after a hold (v1, always `422`: no hold can exist) | **retired (deprecated, 29 Oct 2026)**: use `POST /api/v2/clinical-appraisals/bookings`, which takes no hold |
