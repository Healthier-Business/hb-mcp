# Virtual BLS Training API v2: reference

Base URL: `https://hub.hbcompliance.co.uk/api/v2/virtual-bls-training/`. Portal key `virtual-bls-training`. Every call needs `Authorization: Bearer <access_token>` (from `POST /auth/token` with the API key, body `api_key`) and `Accept: application/json`. The client must have a Virtual BLS account, otherwise every call is `403 portal_unavailable`. Everything is scoped to the key's client. Candidates are managed in the Hub core API (`/api/v2/hub/candidates`, see `../08-hub-core-candidates-api.md`); this API only refers to them by `candidate_ref`. `GET /auth/me` and `POST /auth/revoke` exist only at `/api/v2/auth/`.

## 1. Conventions

* A single resource is `{ "data": { ... } }`. A list is `{ "data": [ ... ], "meta": { "page", "per_page", "total", "last_page", "from", "to" }, "links": { "first", "last", "prev", "next" } }`. Courses are a short fixed list: one page that holds every item.
* Errors are `{ "error": "<code>", "message": "...", "details": { "field": ["message"] } }`; `details` only on `validation_failed`. Codes: `invalid_token` 401, `key_inactive` 403, `ip_not_allowed` 403, `insufficient_scope` 403, `portal_unavailable` 403, `payment_required` 402, `not_found` 404, `conflict` 409, `idempotency_conflict` 409, `validation_failed` 422, `booking_rejected` 422, `rate_limited` 429.
* Another client's record is always `404 not_found`. An unknown or other-client `candidate_ref` in a body or filter is `422 validation_failed` on `candidate_ref`. (No path in this API contains a `candidate_ref`.)
* Pagination: `page` (default 1), `per_page` (default 25, 1 to 100) on every list, including `GET /timeslots`. Search is `search`. Date ranges are `{field}_from` and `{field}_to` (`YYYY-MM-DD`).
* Dates and times: ISO 8601 UTC with `Z`. A session is stored as UK local time and returned converted (11:00 in summer is `...T10:00:00Z`). The **inputs** `date` and `time` of timeslots, holds and reschedules are UK local time. Date-only fields are `YYYY-MM-DD`.
* Money: integer pence in fields ending `_pence`, with `currency: "GBP"` beside it. **Credits are whole credits, not money.**
* Ids are integers, except `candidate_ref` (uuid string) and a hold, addressed by `hold_hash` (string).
* Candidate: always the `candidate_ref`, the same value as in the Hub core API. The integer HB Portal candidate id is never returned.
* `Idempotency-Key` header on every POST that creates something (`POST /timeslots/hold`, `POST /bookings`): within 24 hours the same key and body returns the original answer with `Idempotent-Replayed: true`; the same key with a different body is `409 idempotency_conflict`.
* Per-minute throttle `virtual-bls-training-api`: 120 calls a minute per access token (per IP address when there is none), answered with `429 rate_limited` and `Retry-After`; the hourly per-key limit applies as everywhere.

## 2. Scopes

| Scope | Endpoints |
| --- | --- |
| `virtual-bls-training:account:read` | `GET /profile`, `GET /booking-url` |
| `virtual-bls-training:credits:read` | `GET /credits`, `GET /credits/transactions` |
| `virtual-bls-training:catalogue:read` | `GET /courses`, `GET /timeslots` |
| `virtual-bls-training:holds:write` | `POST /timeslots/hold`, `DELETE /timeslots/hold/{hash}` |
| `virtual-bls-training:bookings:read` | `GET /bookings`, `GET /bookings/{booking}`, `GET /bookings/{booking}/certificate` |
| `virtual-bls-training:bookings:write` | `POST /bookings`, `POST /bookings/{booking}/reschedule`, `POST /bookings/{booking}/cancel` |

`virtual-bls-training:*` and `*` cover all. **Moved:** credits and the ledger were under `account` and are now under `credits`. Keys copied from the old portal have `virtual-bls-training:*` and are unaffected. Missing scope: `403 insufficient_scope`.

## 3. Endpoints

The field-by-field reference of every request, response and error is in the OpenAPI document (`docs/developers/openapi/hub-v2.json`); this section explains how the calls fit together. Every call below needs the scope shown in section 2 and a client with a Virtual BLS account.

### 3.0 The sequence of a booking

1. `GET /courses` to choose a course `id` and see its price.
2. `GET /timeslots?course_id=` to see the free start times (UK local time).
3. `POST /timeslots/hold` to reserve one slot for 30 minutes. An account holds one slot at a time.
4. `POST /bookings` with the `hold_hash`, the `candidate_ref` of a Hub candidate, the address the training kit is posted to and the way of paying. The hold is used up.
5. Listen to the webhook events (`booking.created`, `booking.confirmed`, and later `booking.attendance_marked`, `booking.certificate_available`), or read `GET /bookings/{booking}`.
6. If plans change: `POST /bookings/{booking}/reschedule` (to another free slot) or `POST /bookings/{booking}/cancel`.
7. After the session: `GET /bookings/{booking}/certificate` once `certificate_available` is `true`.

If the candidate changes their mind before step 4, `DELETE /timeslots/hold/{hash}` frees the slot at once. A hold that is not booked ends by itself after 30 minutes.

### 3.1 Account

`GET /profile` returns the account: `id` (Hub client id), `name`, `contact_name`, `email`, `notify_email` (where booking notifications go, and the agency email of a booking when you send none), `client_active`.

`GET /booking-url` returns `booking_url`: the link you give candidates so that they book and pay for a session themselves, or null when the account has none. Bookings made on that page belong to no account, are not made through this API, and send no webhook events.

`GET /credits` returns `booking_credits` (a list of `course_id`, `course_name`, `credits`; only courses with credits left, one credit pays for one place), `booking_balance_pence` (the money balance in pence) and `currency`. Check it before you book with `credits` or `balance`.

`GET /credits/transactions` lists the wallet movements, newest first. Query: `wallet` (`booking_balance` or a course id), `type` (`deposit`, `withdraw`), `created_from`, `created_to`, `sort` (`id`, `created_at`), `page`, `per_page`. Row: `id`, `type`, `wallet` (`booking_balance` or the course id as a string), `amount_pence` and `currency` (money wallet, otherwise null), `credits` (credit wallet, otherwise null), `confirmed`, `description`, `booking_id`, `created_at`. Amounts are positive; `type` says which way they moved. A booking paid with a credit or from the balance takes one `withdraw` when the booking is made, and a refund adds a `deposit`.

### 3.2 Catalogue and holds

`GET /courses` lists the active courses: `id`, `name`, `cost_inc_vat_pence` (list price), `client_rate_pence` (your own rate, 0 when none; it is charged only for `invoice` and `balance` bookings), `currency`, `duration_hours` (hours with the minutes as decimals: `0.3` is 30 minutes, `1.45` is 1 hour 45 minutes).

`GET /timeslots`. Query: `course_id` (required; an unknown course is `422` on `course_id`), `months_ahead` (1 to 12, default 2), `date` (`YYYY-MM-DD`), `sort` (`date`, `time`), `page`, `per_page`. Rows: `date`, `time` (UK local time) and `course` (`id`, `name`). Slots start every 15 minutes between 07:00 and 22:00 UK time; the first bookable day is five days from today; a slot is free when a trainer is free for the whole session and nobody else has promised or held it. The list is a snapshot.

`POST /timeslots/hold` (`holds:write`, `Idempotency-Key`). Body: `course_id`, `date` (`YYYY-MM-DD`), `time` (`HH:MM`), UK local time. Holds one slot for 30 minutes. `201`: `hold_hash`, `expires_at`, `expires_in_seconds`, `slot` (`date`, `time`, `course`). `409 conflict` when your account already holds a slot: the error body carries the existing hold in a top-level `hold` field. A slot that is not free, or a course that is not active: `422 booking_rejected`. A hold sends no webhook event and charges nothing.

`DELETE /timeslots/hold/{hash}` (`holds:write`): `{ "data": { "hold_hash": "...", "released": true } }`. A hash that is unknown, belongs to another account or has been booked is `404 not_found`.

### 3.3 Bookings

Booking row: `id`, `candidate_ref` (the Hub candidate whose HB Portal candidate id, else email, matches the booking; **null** when the account has no such Hub candidate), `candidate_name`, `course` (`id`, `name`), `start_date`, `end_date` (UTC), `booking_status` (`pending`, `booked`, `rescheduled`, `cancelled`, `refunded`), `pay_status` (`pending`, `completed`, `refunded`), `pay_option` (`credits`, `balance`, `inv`, `cc`), `booked_by` (`Agency` for every booking made through this API), `cost_pence`, `currency`, `attendance` (`attended`, `no_show` or null), `virtual` (`zoom_id`, `zoom_link`, `zoom_password`, null until the meeting exists), `can_reschedule`, `can_cancel` (always the same value: paid, open and not started), `certificate_available`, `created_at`. The detail adds `trainer` (`id`, `name`) or null, `refund_eligible` (set when the booking is cancelled, null before) and, on the `POST /bookings` answer for `candidate_pays`, `payment_url`. Abandoned bookings are never listed. The candidate's email, phone and job role are not returned; read them from the Hub candidate.

`GET /bookings` (`bookings:read`). Query: `status` (one or many), `course_id`, `candidate_ref`, `start_date_from`, `start_date_to`, `created_from`, `created_to`, `upcoming`, `past` (booleans), `search` (part of the first name, last name or email on the booking; a full name does not match), `sort` (`start_date`, `created_at`, `status`), `page`, `per_page`. Newest session first.

`GET /bookings/{booking}` (`bookings:read`): the detail.

`POST /bookings` (`bookings:write`, `Idempotency-Key`). Body:

| Field | Rule |
| --- | --- |
| `hold_hash` | required, at most 64 characters; a live hold of this account (unknown, other account's or expired: `422` on `hold_hash`) |
| `candidate_ref` | required, uuid; a Hub candidate of this account (`422` on `candidate_ref` otherwise) |
| `address` (500), `city` (255), `postcode` (20) | required: where the kit is posted (this is not the candidate's identity, so it stays in the booking) |
| `pay_option` | required: `credits`, `balance`, `invoice` (or `inv`), `candidate_pays` |
| `agency_contact_name`, `agency_contact_email` | required (255 characters; the email must be valid) |
| `agency_email` | optional email; the account's `notify_email` when left out |
| `booking_fields` | optional object: answers to the booking questions, keyed `field_<question id>` (a checkbox answer is an array of strings); a required question that is not answered is `422` on `booking_fields.field_<id>`. No call lists the questions |

First name, last name, email, phone and job role (the Hub candidate's first role) come from the Hub candidate. A candidate without a first name, an email or a phone number, or whose name the booking rules refuse (letters and spaces only), is `422` on `candidate_ref`. The booking is made exactly as the Bookings page makes it (`BookingService::create`). The booking carries no separate portal-side candidate row; the HB Portal account is provisioned afterwards by the existing job.

What `pay_option` does:

| `pay_option` | Result |
| --- | --- |
| `credits` | one credit of the held course is taken now; the booking is `booked`, `pay_status` `completed`; the confirmation email and text are sent |
| `balance` | the price (your own rate if any, else the list price) is taken from the money balance now; as above |
| `invoice` / `inv` | charged to the account by invoice at your own rate or the list price; as above; `pay_option` shows `inv` |
| `candidate_pays` | the booking is `pending` and the candidate is emailed a card payment link, returned as `payment_url`; it becomes `booked` when they pay; the link stops taking payment 3 days before the session and an unpaid booking is cancelled automatically when the session is 5 days away or less. It is never abandoned after an hour: that clean-up of unpaid pending bookings, where it is switched on, skips a `candidate_pays` booking made through the API |

Paying by card as the agency is not available. A way of paying the account cannot cover (no credit, balance below the price, invoicing not open or credit limit too low) is `422 booking_rejected` ("That way of paying is not available for this booking."), not `402`. `201` with the detail.

`POST /bookings/{booking}/reschedule` (`bookings:write`). Body: `date`, `time` (UK local, a free slot at least five days ahead; no hold needed). Returns the detail with `booking_status` `rescheduled`. The trainer is released (a new one is assigned later), the Zoom meeting and the trainer's calendar entry are moved, the candidate is emailed and `booking.rescheduled` is sent. Within 120 hours (five days) of the session a flat fee (the platform default is 20 pounds) must be paid first: `402 payment_required` with `payment_url`, where the candidate pays by card; then call again. A booking that is not paid, is cancelled or refunded, has started, or a slot that is not free: `422 booking_rejected`. No `Idempotency-Key`.

`POST /bookings/{booking}/cancel` (`bookings:write`): returns the detail. The trainer, calendar entry and Zoom meeting are released, the candidate is emailed and `booking.cancelled` is sent (before any refund). More than 120 hours before the session the booking is `refund_eligible` and refunded automatically: a credit goes back as a deposit, balance money goes back onto the balance, a card payment is refunded to the card, an invoice booking has nothing to refund; once refunded `booking_status` is `refunded`. Within 120 hours nothing is refunded. A booking that cannot be cancelled (not paid yet, already cancelled or refunded, started): `409 conflict`.

`GET /bookings/{booking}/certificate` (`bookings:read`): `application/pdf`, attachment `bls_cert_{id}.pdf`; before it is earned (attended and kit returned): `409 conflict`.

### 3.4 Worked example

The account has Hub client id 1001, a candidate with `candidate_ref` `9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f` (Jo Smith, with an email address and phone number in Hub) and three credits for Basic Life Support. Today is 28 October 2026. All calls carry `Authorization: Bearer <access_token>` and `Accept: application/json`; UK time equals UTC in November.

**1. List the free slots** for 10 November 2026.

```
GET /api/v2/virtual-bls-training/timeslots?course_id=1&date=2026-11-10&per_page=2
```

```json
{
  "data": [
    { "date": "2026-11-10", "time": "09:00", "course": { "id": 1, "name": "Basic Life Support" } },
    { "date": "2026-11-10", "time": "09:15", "course": { "id": 1, "name": "Basic Life Support" } }
  ],
  "meta": { "page": 1, "per_page": 2, "total": 60, "last_page": 30, "from": 1, "to": 2 },
  "links": {
    "first": "https://hub.hbcompliance.co.uk/api/v2/virtual-bls-training/timeslots?course_id=1&date=2026-11-10&per_page=2&page=1",
    "last": "https://hub.hbcompliance.co.uk/api/v2/virtual-bls-training/timeslots?course_id=1&date=2026-11-10&per_page=2&page=30",
    "prev": null,
    "next": "https://hub.hbcompliance.co.uk/api/v2/virtual-bls-training/timeslots?course_id=1&date=2026-11-10&per_page=2&page=2"
  }
}
```

(The numbers in `meta` and `links` are illustrative: they depend on trainer availability.)

**2. Hold the 11:00 slot.**

```
POST /api/v2/virtual-bls-training/timeslots/hold
Idempotency-Key: hold-2026-11-10-1100-jo
Content-Type: application/json

{ "course_id": 1, "date": "2026-11-10", "time": "11:00" }
```

```json
{
  "data": {
    "hold_hash": "Qm7xT2kLp9VdR4sNw8YbHc3JfAe6ZuGo",
    "expires_at": "2026-10-28T14:30:00Z",
    "expires_in_seconds": 1800,
    "slot": { "date": "2026-11-10", "time": "11:00", "course": { "id": 1, "name": "Basic Life Support" } }
  }
}
```

**3. Book it for the candidate, paying with a credit.**

```
POST /api/v2/virtual-bls-training/bookings
Idempotency-Key: booking-jo-2026-11-10
Content-Type: application/json

{
  "hold_hash": "Qm7xT2kLp9VdR4sNw8YbHc3JfAe6ZuGo",
  "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "address": "1 High Street",
  "city": "London",
  "postcode": "SW1A 1AA",
  "pay_option": "credits",
  "agency_contact_name": "Sam Jones",
  "agency_contact_email": "sam@acme.test"
}
```

`201 Created`:

```json
{
  "data": {
    "id": 77,
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "candidate_name": "Jo Smith",
    "course": { "id": 1, "name": "Basic Life Support" },
    "start_date": "2026-11-10T11:00:00Z",
    "end_date": "2026-11-10T11:30:00Z",
    "booking_status": "booked",
    "pay_status": "completed",
    "pay_option": "credits",
    "booked_by": "Agency",
    "cost_pence": 4800,
    "currency": "GBP",
    "attendance": null,
    "virtual": { "zoom_id": null, "zoom_link": null, "zoom_password": null },
    "can_reschedule": true,
    "can_cancel": true,
    "certificate_available": false,
    "created_at": "2026-10-28T14:00:12Z",
    "trainer": null,
    "refund_eligible": null
  }
}
```

One credit has been taken (`GET /credits` now shows 2). The trainer and the Zoom details appear later.

**4. The webhook events.** Two events reach your endpoint (subscribe to `virtual-bls-training.booking.created` and `virtual-bls-training.booking.confirmed` in `/api/v2/webhooks`). Verify the `X-Hub-Signature` header first (section 4).

```json
{
  "event_id": "3f6d2c1e-8a47-4b9e-9c55-1d2e7a0b6f41",
  "event_type": "virtual-bls-training.booking.created",
  "occurred_at": "2026-10-28T14:00:12Z",
  "data": {
    "booking_id": 77,
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "course_id": 1,
    "course": "Basic Life Support",
    "start_date": "2026-11-10T11:00:00Z",
    "pay_option": "credits",
    "status": "booked"
  }
}
```

```json
{
  "event_id": "c8b1a7d4-52e3-4f06-b2a9-6e0f3d91a5c8",
  "event_type": "virtual-bls-training.booking.confirmed",
  "occurred_at": "2026-10-28T14:00:12Z",
  "data": {
    "booking_id": 77,
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "course_id": 1,
    "course": "Basic Life Support",
    "start_date": "2026-11-10T11:00:00Z",
    "pay_status": "completed",
    "transaction_id": null
  }
}
```

**5. Reschedule** to 17 November at 14:00 (more than five days ahead, so there is no fee).

```
POST /api/v2/virtual-bls-training/bookings/77/reschedule
Content-Type: application/json

{ "date": "2026-11-17", "time": "14:00" }
```

The answer is the detail with `"booking_status": "rescheduled"`, `"start_date": "2026-11-17T14:00:00Z"`, `"end_date": "2026-11-17T14:30:00Z"` and `"trainer": null` (a new trainer is assigned later); `virtual` keeps the Zoom meeting, moved to the new time. The event `virtual-bls-training.booking.rescheduled` follows with `"status": "rescheduled"` and the new `start_date`. Had the session been within 120 hours, the call would have answered:

```json
{
  "error": "payment_required",
  "message": "This training is within 5 days. A reschedule fee applies.",
  "payment_url": "https://hub.hbcompliance.co.uk/virtual-bls-training/reschedule/a1b2c3d4e5?signature=...",
  "request_id": "01JBX4R9T7M2KQ8W5N3E6H1ZPA"
}
```

**6. Cancel** the booking (the session is still more than 120 hours away, so the credit is refunded).

```
POST /api/v2/virtual-bls-training/bookings/77/cancel
```

```json
{
  "data": {
    "id": 77,
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "candidate_name": "Jo Smith",
    "course": { "id": 1, "name": "Basic Life Support" },
    "start_date": "2026-11-17T14:00:00Z",
    "end_date": "2026-11-17T14:30:00Z",
    "booking_status": "refunded",
    "pay_status": "refunded",
    "pay_option": "credits",
    "booked_by": "Agency",
    "cost_pence": 4800,
    "currency": "GBP",
    "attendance": null,
    "virtual": { "zoom_id": null, "zoom_link": null, "zoom_password": null },
    "can_reschedule": false,
    "can_cancel": false,
    "certificate_available": false,
    "created_at": "2026-10-28T14:00:12Z",
    "trainer": null,
    "refund_eligible": true
  }
}
```

The credit is back (a `deposit` in `GET /credits/transactions`). The event `virtual-bls-training.booking.cancelled` is sent first, with `"status": "cancelled"` (it is sent before the refund; read the booking for `refunded`). Cancelling again is `409 conflict`.

## 4. Webhooks

Delivery, signature headers and retries are those of Hub webhooks (`/api/v2/webhooks`). Body: `event_id`, `event_type`, `occurred_at`, `data`. Event names are prefixed `virtual-bls-training.`. Events for Hub account endpoints carry the `candidate_ref` and ids; they do not carry the candidate's name or email. `start_date` is UTC with `Z`, and so is `occurred_at`. The older BLS endpoints keep the old bodies with `candidate_name`. A booking that a candidate makes for themselves on the public booking page belongs to no account and sends no event. The `webhook.test` event of the older BLS endpoints is not sent to Hub endpoints; Hub's own test delivery (`webhook.test`, with `message` and `endpoint_id`) is.

Every event shares `data`: `booking_id`, `candidate_ref` (null when the account has no matching Hub candidate), `course_id`, `course` (the course name), `start_date`.

| Event | When | Extra `data` fields |
| --- | --- | --- |
| `booking.created` | a booking was created (API or the Bookings page) | `pay_option` (`credits`, `balance`, `inv`, `cc`), `status` (`booked` or `pending`) |
| `booking.confirmed` | a booking became paid and booked: at once for credits, balance and invoice, on payment for a booking the candidate pays | `pay_status`, `transaction_id` (card payments; null otherwise) |
| `booking.rescheduled` | a booking was moved (API, the Bookings page or an administrator) | `status` (`rescheduled`) |
| `booking.cancelled` | cancelled by a client or administrator (before any refund), when a candidate opens an expired payment link of an unpaid booking, or when an unpaid candidate-pays booking is auto-cancelled 5 days before the session | `status` (`cancelled`) |
| `booking.attendance_marked` | the trainer or an administrator recorded attendance (sent again if it is recorded again) | `attendance` (`passed`, `present`, `absent`), `id_checked` |
| `booking.equipment_late` | a late kit reminder was emailed (the first 4 to 6 days after the session, the second 7 to 9, the third 10 or more) | `days_overdue`, `notice_number` (1 to 3) |
| `booking.certificate_available` | the candidate finished the e-learning modules and the kit is back; the certificate was announced | none |

Example (`booking.cancelled`):

```json
{
  "event_id": "7d41b0aa-3c52-4e8f-a1d6-9b2e5c0f8a37",
  "event_type": "virtual-bls-training.booking.cancelled",
  "occurred_at": "2026-10-28T19:53:24Z",
  "data": { "booking_id": 77, "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", "course_id": 1, "course": "Basic Life Support", "start_date": "2026-10-20T10:00:00Z", "status": "cancelled" }
}
```

The schema and a full example of every event are in the OpenAPI document (`webhooks`), written in `docs/developers/openapi/overrides/webhook-data-virtual-bls-training.json`.

## 5. v1 to v2

The old API (`/api/virtual-bls-training/v1`, `/api/bls`) keeps working unchanged.

| v1 | v2 |
| --- | --- |
| `POST /auth/token` (`hb_client_id` + `api_key`), `/auth/refresh` | `POST /api/v2/auth/token` and `POST /api/v2/auth/refresh`: one exchange for every portal, no per-portal auth routes; body `api_key` only (a Hub API key, which carries the scopes of the portals it may use) |
| `GET /auth/token-info`, `POST /auth/revoke` | `GET /api/v2/auth/me`, `POST /api/v2/auth/revoke` |
| `GET /booking-url` | `GET /booking-url` in `data` |
| `GET /credits` (`booking_money_balance` pounds) | `GET /credits` (`booking_balance_pence`, scope `credits:read`) |
| `GET /transactions` (`amount`, `confirmed`, `meta`) | `GET /credits/transactions` (`amount_pence` or `credits`, `description`, `booking_id`; `created_from`/`created_to`) |
| `GET /courses` (`cost_inc_vat`, `client_rate` pounds) | `cost_inc_vat_pence`, `client_rate_pence` |
| `GET /timeslots` (`data` and `meta {course_id, months_ahead, total}`, unpaged) | paged with the standard `meta` and `links` |
| `POST /timeslots/hold` (unwrapped; 409 `{message,hold_hash,slot}`) | wrapped in `data`; 409 `conflict` with `hold`; `Idempotency-Key` |
| `GET /bookings` (`candidate` object; `date_from`/`date_to`; default 20) | `candidate_ref` + `candidate_name`; `candidate_ref` filter; `start_date_from`/`start_date_to`; default 25; times in UTC with `Z` (v1 had the UK offset) |
| `POST /bookings` (`first_name`, `last_name`, `email`, `phone`, `job_role`) | `candidate_ref` instead of those five; address, city, postcode stay |
| `POST /bookings/{id}/reschedule` 422 `{message, code: PAYMENT_REQUIRED, payment_url}` | 402 `payment_required` with `payment_url` |
| `GET/POST/PUT/DELETE /webhooks...` | `/api/v2/webhooks` |
| `GET /api/bls/getBookingLinkForClient/{client_id}` (public) | `GET /booking-url` (authenticated) |
