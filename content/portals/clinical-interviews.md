# Clinical Interviews API v2: reference

This is the contract of the Clinical Interviews API. The full, machine readable description of every operation, field and webhook event is `docs/developers/openapi/hub-v2.json` (written from the controllers, resources and `docs/developers/openapi/overrides/clinical-interviews*.json`, and linted by `php artisan api:docs:lint --portal=clinical-interviews`); this page explains how the calls fit together and gives a complete worked example.

Base URL: `https://hub.hbcompliance.co.uk/api/v2/clinical-interviews/`. Portal key `clinical-interviews`. Every call needs `Authorization: Bearer <access_token>` (from `POST /auth/token` with the API key) and `Accept: application/json`. The client must have a Clinical Interviews account, otherwise every call is `403 portal_unavailable`. Everything is scoped to the key's client. Calls are rate limited per key (`429 rate_limited` with `Retry-After`).

## 1. Conventions

* A single resource is `{ "data": { ... } }`. A list is `{ "data": [ ... ], "meta": { "page", "per_page", "total", "last_page", "from", "to" }, "links": { "first", "last", "prev", "next" } }`. Interview types are a short fixed list: one page that holds every item.
* Errors are `{ "error": "<code>", "message": "...", "details": { ... } }`. `details` is present on `validation_failed` (field to messages) and on `hold_exists` (the existing hold). Every error also carries a `request_id` (the `X-Request-Id` header). Codes: `invalid_token` 401, `insufficient_scope`, `portal_unavailable`, `client_restricted`, `blocked` (the caller's internet address has been blocked from holding slots) 403, `not_found` 404, `idempotency_conflict`, `hold_exists`, `slot_taken` 409, `validation_failed`, `booking_refused`, `hold_refused`, `late_reschedule_not_allowed`, `reschedule_refused`, `cancel_refused`, `report_not_available` 422, `report_expired` 410, `rate_limited`, `too_fast`, `client_limit`, `ip_limit` (the last three are the slot hold limits) 429.
* One convention for refusals: `409` is a clash with the current state of a slot, hold or key (`slot_taken`, `hold_exists`, `idempotency_conflict`); `422` is a business refusal of a request that was valid (`booking_refused`, `hold_refused`, `reschedule_refused`, `cancel_refused`, `late_reschedule_not_allowed`, `report_not_available`) or a field that is wrong (`validation_failed`); `402` is never used in this portal (a balance or credit that is too short for a booking is `422 booking_refused`, and a late reschedule is never blocked by it). Losing a slot is always `409 slot_taken`, also in the moment of a move.
* Another client's record is always `404 not_found`, never `403`.
* Pagination: `page` (default 1) and `per_page` (default 25, 1 to 100; more is `422 validation_failed`).
* Dates and times: ISO 8601 UTC with `Z` (`2026-10-12T10:00:00Z`; an interview at 11:00 UK summer time is `10:00:00Z`). Every time the API returns is a real instant: the interview time is stored as UK wall-clock time and converted with the clock changes taken into account (11:00 UK on 1 July is `10:00:00Z`, 11:00 UK on 1 December is `11:00:00Z`). Date filters (`start_date_from`/`_to`, `created_from`/`_to`) accept a date alone (`2026-10-12`), which is a UK calendar day (from 00:00 to the start of the next day UK time, so a day is 23 or 25 hours long when the clocks change; `created_from=2026-07-02` starts at `2026-07-01T23:00:00Z`), or a date and time: with `Z` or an offset it is that exact instant (`_to` includes it), and with no offset it is read as UTC. A slot's `date` and `time` (`HH:MM`) are UK wall-clock time as in `GET /timeslots`; a time that does not exist (01:00 to 01:59 on the last Sunday of March) is `422 validation_failed` on `time`, and the repeated hour in October (01:00 to 01:59 on the last Sunday of October) means its second occurrence, in winter time.
* Money: integer pence in fields ending `_pence`, with a `currency: "GBP"` field beside it. Credits are whole units (numbers, not pence).
* Candidate: always the `candidate_ref` (uuid), the same value as in the Hub core API (`/api/v2/hub/candidates`). There is no integer candidate id. Create the person first with `POST /api/v2/hub/candidates`.
* `Idempotency-Key`: send it on `POST /timeslots/hold`, `POST /bookings` and `POST /bookings/{id}/reschedule`. The same key and body within 24 hours returns the original answer with `Idempotent-Replayed: true`; the same key with a different body is `409 idempotency_conflict`.
* Ids (`id`, `interview_type_id`, interviewer id) are integers.

## 2. Scopes

| Scope | Endpoints |
| --- | --- |
| `clinical-interviews:account:read` | `GET /profile` |
| `clinical-interviews:credits:read` | `GET /credits`, `GET /credits/transactions` |
| `clinical-interviews:catalogue:read` | `GET /interview-types`, `GET /timeslots` |
| `clinical-interviews:holds:write` | `POST /timeslots/hold`, `DELETE /timeslots/hold/{hash}` |
| `clinical-interviews:bookings:read` | `GET /bookings`, `GET /bookings/{id}`, `GET /bookings/{id}/interview-report` |
| `clinical-interviews:bookings:write` | `POST /bookings`, `POST /bookings/{id}/reschedule`, `POST /bookings/{id}/cancel` |

`clinical-interviews:*` and `*` cover all. A `:write` scope does not include its `:read` scope: give both. Missing scope: `403 insufficient_scope`.

## 3. Endpoints

`GET /profile`: `id` (the Hub client id), `name`, `contact_name`, `email`, `notify_email`, `client_active`.

`GET /credits`: `booking_credits` (list of `interview_type_id`, `interview_type_name`, `credits`), `interview_type_group_credits` (credit pools: `pool`, `name`, `interview_type_ids`, `credits`), `all_interview_types_credits`, `booking_money_balance_pence`, `currency`. A client that uses another client's credits sees that client's credit balances.

`GET /credits/transactions`. Query: `wallet` (an interview type id, `all`, a pool key or `booking_balance`), `type` (`deposit` or `withdraw`), `created_from`, `created_to` (a date is a UK calendar day; a time with `Z` or an offset is an exact instant), `page`, `per_page`. Rows: `id`, `type`, `confirmed`, `wallet`, `is_money`, `amount` (credits; null for money), `amount_pence` and `currency` (money; null for credits), `booking_id`, `created_at`.

`GET /interview-types`: `id`, `name`, `price_inc_vat_pence`, `client_rate_pence`, `currency`, `duration_hours`.

`GET /timeslots`. Query: `interview_type_id` (required), `months_ahead` (1 to 12, default 2), `date` (one day), `page`, `per_page`. Rows: `date`, `time`, `interview_type` (`id`, `name`).

`POST /timeslots/hold` (`Idempotency-Key`). Body: `interview_type_id`, `date`, `time` (the `date` and `time` of a row of `GET /timeslots`, UK local time). A client holds one slot at a time, for 5 minutes by default (`expires_in_seconds` says how long). `201` with `hold_hash`, `expires_at`, `expires_in_seconds`, `slot` (`date`, `time`, `interview_type`). A hold sends no email and no webhook and charges nothing. Another hold already open: `409 hold_exists` with that hold in `details`. A slot that is no longer free, or an interview type that cannot be booked: `422 hold_refused`. Too many open holds, or opening slots too quickly: `429 client_limit`, `429 ip_limit`, `429 too_fast`. An address blocked by Healthier Business: `403 blocked`. `DELETE /timeslots/hold/{hash}`: `data.released: true`; unknown hash `404 not_found`.

`GET /bookings`. Query: `status` (one or many of `pending`, `booked`, `rescheduled`, `cancelled`, `abandoned`, `refunded`...), `interview_status` (one or many), `interview_type_id`, `candidate_ref`, `start_date_from`, `start_date_to` (the interview day, UK calendar days when a date alone), `created_from`, `created_to` (the day the booking was made, in the same way), `sort`, `upcoming`, `past`, `search` (name or email), `page`, `per_page`. A `candidate_ref` that is not one of the client's candidates is `422 validation_failed` on `candidate_ref`. Abandoned bookings are not listed.

Booking fields: `id`, `candidate_ref` (null for an older booking whose person is not a Hub candidate), `candidate_name`, `candidate_email`, `candidate_phone`, `job_role`, `nmc_number`, `interview_type` (`id`, `name`), `interviewer` (`id`, `name` or null), `start_date`, `end_date`, `booking_status`, `interview_status`, `attendance`, `incomplete_reason`, `video_provider`, `cancelled`, `can_reschedule`, `can_cancel`, `pay_status`, `pay_option`, `booked_by`, `zoom` (`meeting_id`, `join_link`, `password`), `interview_report_available`, `created_at`.

How a booking gets its `candidate_ref`: a booking made through this API (or the Hub Book now page) belongs to the Hub candidate; a booking without that link is matched to the client's Hub candidate with the same email, else `candidate_ref` is null.

`GET /bookings/{id}`: the booking. `POST /bookings` (`bookings:write`, `Idempotency-Key`). Body:

| Field | Rule |
| --- | --- |
| `hold_hash` | required, the hold of this client |
| `candidate_ref` | required, uuid of one of the client's Hub candidates (`422` on `candidate_ref` otherwise, never 404). The name, email and phone come from the Hub candidate. A candidate with no name, email or phone gets `422` on `candidate_ref` |
| `phone` | optional, used when the Hub candidate has none |
| `job_role`, `nmc_number`, `nursing_band` | optional |
| `pay_option` | required: `credits`, `balance`, `invoice` (or `inv`) |
| `agency_contact_name`, `agency_contact_email` | required |
| `agency_email` | optional (default: the account's notification email) |
| `agency_contact_cc` | optional, up to 10 addresses separated by single commas, at most 500 characters |
| `booking_fields` | optional object `{ "field_{question id}": answer }`: the answers to the booking questions set up for the interview type. A required question left unanswered is `422` on `booking_fields.field_{id}`. The API does not list the questions |

`201` with the booking, confirmed and paid at once. With `credits` one credit is taken now (the credits of the interview type first, then a pool that covers it, then the all-types credits); with `balance` the price is taken from the booking money balance now; with `invoice` nothing is taken now. The candidate and the agency contact are emailed, the webhook `booking.created` is sent, and `interviewer` is null until one is assigned. Refused (no credit, balance too low, option not available, hold unknown or expired): `422 booking_refused`, never `402`. Restricted account: `403 client_restricted`. A retry without an `Idempotency-Key` finds the hold already used and is `422 booking_refused`.

`POST /bookings/{id}/reschedule` (`Idempotency-Key`). Body: `date`, `time`. Returns the booking. A time that cannot be booked (taken, too soon, or no interviewer free) is `409 slot_taken`; a booking that cannot be moved at all (unpaid, closed, already started, in the past) is `422 reschedule_refused`; under 24 hours' notice a card booking (made in Hub, never through the API) is `422 late_reschedule_not_allowed`. Moving with 24 hours' notice or more is free; under 24 hours it is charged as a new booking (see the operation's description in the OpenAPI document). The late charge never blocks the move, as in the Clinical Interviews portal: a balance booking is charged the interview price even when the booking money balance is short (the balance goes below zero), and a credit booking takes a credit even when none is left. Repeating a reschedule is safe: the same `Idempotency-Key` and body returns the original answer (`Idempotent-Replayed: true`), and without a key a call for the slot the booking is already in answers `200` with the booking as it is, without clearing the interviewer, sending an email or a webhook event, or charging again (also when two identical calls race). `POST /bookings/{id}/cancel`: returns the booking plus `refund_eligible` and `late_cancellation` (free with 24 hours' notice or more, a late cancellation under 24 hours: nothing is given back); an already cancelled booking is returned as it is, without those two fields; a booking that cannot be cancelled is `422 cancel_refused`.

`GET /bookings/{id}/interview-report`: the PDF. `422 report_not_available` before the interview is completed; `410 report_expired` after the retention period.

## 4. Webhooks

Delivery, signature headers and retries are those of Hub webhooks (`/api/v2/webhooks`): each delivery has the headers `X-Hub-Signature`, `X-Hub-Timestamp`, `X-Hub-Event`, `X-Hub-Event-Id` and `X-Hub-Delivery-Id`, and a failed delivery is retried. Body: `event_id`, `event_type`, `occurred_at`, `data`. Event names are prefixed `clinical-interviews.`. `data` carries ids, the `candidate_ref`, the interview type and statuses; it never carries the candidate's name, email, phone or video link. Times are ISO 8601 UTC with `Z`.

Common `data` fields: `booking_id`, `candidate_ref` (null when the booking's person is not a Hub candidate), `interview_type` (`id`, `name`), `start_date`, `status` (booking status), `interview_status`.

| Event | When | Extra `data` fields |
| --- | --- | --- |
| `booking.created` | a booking was made and needs no payment now (credits, balance or invoice): `POST /bookings`, or a booking made in Hub | `pay_option`, `by` |
| `booking.confirmed` | a card payment confirmed a booking that was waiting for it (never for a booking made through the API) | `pay_status`, `transaction_id`, `by` |
| `booking.rescheduled` | rescheduled (the API, the Hub pages, or staff) | `previous_start_date`, `by` |
| `booking.cancelled` | cancelled (the API, the Hub pages, or staff); not sent again for a booking that is already cancelled | `cancelled_at`, `by` |
| `booking.interview_completed` | the interview ended: `outcome` is `completed`, `no_show` or `incomplete` | `outcome`, `incomplete_reason`, `by` |
| `booking.attendance_marked` | attendance recorded: `attended` or `no_show` | `attendance`, `by` |
| `booking.interview_report_available` | the interviewer submitted the report; `outcome` is `passed`, `failed`, `re_interview` or null | `outcome`, `score`, `by` |
| `webhook.test` | the test button | `message` |

`by` is a fixed value: `agency` on the first four events, `interviewer` on the last three. It does not say who made a change. A booking made through the API is saved with the Hub candidate it is for, so the `candidate_ref` of `booking.created` is that candidate's, even when two of your Hub candidates share an email address. A booking with no candidate link (an older one) is matched to the Hub candidate with the same email address.

Example (`booking.created`):

```json
{
  "event_id": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "event_type": "clinical-interviews.booking.created",
  "occurred_at": "2026-10-05T14:30:13Z",
  "data": { "booking_id": 812, "candidate_ref": "9f1c...", "interview_type": { "id": 3, "name": "Clinical Interview" }, "start_date": "2026-10-12T10:00:00Z", "status": "booked", "interview_status": "scheduled", "pay_option": "credits", "by": "agency" }
}
```

## 5. Worked example: book, reschedule, cancel, report

The calls below use the made up key, ids and addresses of the OpenAPI examples. Every call carries `Authorization: Bearer <access_token>` and `Accept: application/json`. The candidate already exists in Hub (`POST /api/v2/hub/candidates` gave `candidate_ref` `9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f`, with a name, an email address and a phone number).

**1. Find the interview type.** `GET /interview-types` (scope `catalogue:read`):

```json
{ "data": [
  { "id": 3, "name": "Clinical Interview", "price_inc_vat_pence": 12000, "client_rate_pence": 10000, "currency": "GBP", "duration_hours": 1 }
], "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 }, "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/clinical-interviews/interview-types?page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/clinical-interviews/interview-types?page=1", "prev": null, "next": null } }
```

**2. List free slots.** `GET /timeslots?interview_type_id=3&date=2026-10-12&per_page=3`. `date` and `time` are UK local time:

```json
{ "data": [
  { "date": "2026-10-12", "time": "09:00", "interview_type": { "id": 3, "name": "Clinical Interview" } },
  { "date": "2026-10-12", "time": "09:15", "interview_type": { "id": 3, "name": "Clinical Interview" } },
  { "date": "2026-10-12", "time": "11:00", "interview_type": { "id": 3, "name": "Clinical Interview" } }
], "meta": { "page": 1, "per_page": 3, "total": 3, "last_page": 1, "from": 1, "to": 3 }, "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/clinical-interviews/timeslots?page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/clinical-interviews/timeslots?page=1", "prev": null, "next": null } }
```

**3. Hold the 11:00 slot.** `POST /timeslots/hold` with `Idempotency-Key: 5d1e9a52-0c43-4d7a-9a38-6f1b2f7e4c10` (scope `holds:write`):

```json
{ "interview_type_id": 3, "date": "2026-10-12", "time": "11:00" }
```

Answer `201`. The slot is yours for 5 minutes:

```json
{ "data": {
  "hold_hash": "kT3pQ8mZ1xW6vB2nR9sL4dF7hJ0cY5aE",
  "expires_at": "2026-10-05T14:35:12Z",
  "slot": { "date": "2026-10-12", "time": "11:00", "interview_type": { "id": 3, "name": "Clinical Interview" } },
  "expires_in_seconds": 300
} }
```

If you ask for a second hold while this one is open, the answer is `409`, with the open hold in `details` so you can carry on with it:

```json
{ "error": "hold_exists", "message": "You already have an active slot hold. Release it before requesting a new one.",
  "details": { "hold_hash": "kT3pQ8mZ1xW6vB2nR9sL4dF7hJ0cY5aE", "expires_at": "2026-10-05T14:35:12Z", "slot": { "date": "2026-10-12", "time": "11:00", "interview_type": { "id": 3, "name": "Clinical Interview" } } },
  "request_id": "01M6X4Q9T2R7B8C1D3E5F6G7H8" }
```

**4. Book it** with the hold and the `candidate_ref`. `POST /bookings` with `Idempotency-Key: 8b0f4c1e-93a6-4a52-b7d1-2c6e5a9d7f03` (scope `bookings:write`):

```json
{
  "hold_hash": "kT3pQ8mZ1xW6vB2nR9sL4dF7hJ0cY5aE",
  "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "job_role": "Registered Nurse",
  "nmc_number": "12A3456E",
  "pay_option": "credits",
  "agency_contact_name": "Alex Morgan",
  "agency_contact_email": "alex.morgan@northgate.example"
}
```

Answer `201`. The booking is confirmed and paid (one credit was taken), the candidate and Alex Morgan are emailed, and the interviewer is assigned afterwards (`interviewer` is null for now):

```json
{ "data": {
  "id": 812, "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", "candidate_name": "Jane Smith", "candidate_email": "jane.smith@example.com", "candidate_phone": "07700 900123",
  "job_role": "Registered Nurse", "nmc_number": "12A3456E", "interview_type": { "id": 3, "name": "Clinical Interview" }, "interviewer": null,
  "start_date": "2026-10-12T10:00:00Z", "end_date": "2026-10-12T11:00:00Z", "booking_status": "booked", "interview_status": "scheduled", "attendance": null, "incomplete_reason": null,
  "video_provider": "hbmeet", "cancelled": false, "can_reschedule": true, "can_cancel": true, "pay_status": "completed", "pay_option": "credits", "booked_by": "Agency",
  "zoom": { "meeting_id": null, "join_link": null, "password": null }, "interview_report_available": false, "created_at": "2026-10-05T14:30:12Z"
} }
```

Note `start_date`: 11:00 UK summer time is `10:00:00Z`. If this call is repeated with the same `Idempotency-Key` and body, the same answer comes back with `Idempotent-Replayed: true` and nothing is booked or charged twice.

**5. The webhook.** Every endpoint of the account that picked `clinical-interviews.booking.created` receives (the signature headers are described in `/api/v2/webhooks`):

```json
{
  "event_id": "7d3f6a52-1c0e-4b8e-8a57-9e2c4f1d6b30",
  "event_type": "clinical-interviews.booking.created",
  "occurred_at": "2026-10-05T14:30:13Z",
  "data": {
    "booking_id": 812, "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "interview_type": { "id": 3, "name": "Clinical Interview" }, "start_date": "2026-10-12T10:00:00Z",
    "status": "booked", "interview_status": "scheduled", "pay_option": "credits", "by": "agency"
  }
}
```

**6. Reschedule.** `POST /bookings/812/reschedule` with a free slot from `GET /timeslots` (no hold is needed):

```json
{ "date": "2026-10-14", "time": "14:30" }
```

Answer `200` with the booking: `booking_status` is `rescheduled`, `start_date` is `2026-10-14T13:30:00Z`, `interviewer` is null again until a new one is assigned. The candidate and the agency contact are emailed, and `clinical-interviews.booking.rescheduled` is sent with `data.previous_start_date` `2026-10-12T10:00:00Z`. A slot that cannot be booked answers:

```json
{ "error": "slot_taken", "message": "Sorry, that time has just been taken. Please choose another time.", "request_id": "01M6X4Q9T2R7B8C1D3E5F6G7H9" }
```

**7. Or cancel.** `POST /bookings/812/cancel` (no body). With 24 hours' notice or more the answer is the booking with `booking_status` `cancelled` and two extra fields; the credit is given back:

```json
{ "data": { "id": 812, "booking_status": "cancelled", "cancelled": true, "can_reschedule": false, "can_cancel": false, "refund_eligible": true, "late_cancellation": false, "...": "the other booking fields as above" } }
```

`clinical-interviews.booking.cancelled` is sent with `data.cancelled_at`. Under 24 hours' notice the same call answers `late_cancellation: true` and `refund_eligible: false`, and the interview stays charged.

**8. After the interview.** The interviewer ends the interview and the webhooks follow: `booking.interview_completed` (`data.outcome` `completed`), `booking.attendance_marked` (`data.attendance` `attended`) and, when the report is submitted, `booking.interview_report_available` (`data.outcome` `passed`, `data.score` `78`). Then `GET /bookings/812/interview-report` (scope `bookings:read`) returns the PDF (`Content-Type: application/pdf`, `Content-Disposition: attachment; filename="Jane Smith OUTCOME.pdf"`). Before the interview is completed the answer is `422 report_not_available`:

```json
{ "error": "report_not_available", "message": "Interview report is not available. The interview must be completed first.", "request_id": "01M6X4Q9T2R7B8C1D3E5F6G7HA" }
```

The report is a sensitive personal record of the candidate: do not log it and keep it only as long as you need it.

## 6. v1 to v2

| v1 | v2 |
| --- | --- |
| `GET /transactions` (scope `account:read`) | `GET /credits/transactions` (scope `credits:read`) |
| `GET /credits` (scope `account:read`) | `GET /credits` (scope `credits:read`) |
| bare object for one resource | `{ "data": {...} }` |
| list `meta.current_page`, `last_page`, `per_page`, `total`; default 20 | `meta.page`, `per_page`, `total`, `last_page`; default 25 |
| booking `candidate` (name, email, phone, job_role, nmc_number) | `candidate_ref`, `candidate_name`, `candidate_email`, `candidate_phone`, `job_role`, `nmc_number` |
| `POST /bookings` with `first_name`, `last_name`, `email`, `phone` | `candidate_ref` (and optional `phone`) |
| `course_id` filter and `interview_type_id` | `interview_type_id` only |
| `date_from`, `date_to` | bookings: `start_date_from`, `start_date_to`; transactions: `created_from`, `created_to` |
| booking and event times `+01:00` offsets | UTC with `Z` |
| `cost_inc_vat`, `client_rate` (pounds, decimals) | `price_inc_vat_pence`, `client_rate_pence`, `currency` |
| `booking_money_balance` (pounds) | `booking_money_balance_pence`, `currency` |
| credits `course_id`, `course_name` | `interview_type_id`, `interview_type_name` |
| transaction `amount` for money in pence, `meta` | `amount_pence` + `currency` (money) or `amount` (credits); `meta` is not returned |
| errors `{ message }` or `{ message, code: "SLOT_TAKEN" }` | `{ error: "slot_taken", message }` (all snake_case) |
| hold conflict `409` with `hold_hash`, `slot` at the top level | `409 hold_exists`, the hold in `details` |
| `DELETE /timeslots/hold/{hash}` answer `{ message }` | `{ "data": { "hold_hash", "released": true } }` |
| `timeslots` answer `meta.interview_type_id`, `months_ahead`, `total` | paged list with the standard `meta` |
| webhook `data.booking` (whole booking, candidate details, video link), `candidate_name` | `candidate_ref`, no personal data, no video link |
| no `Idempotency-Key` | `Idempotency-Key` on hold and booking |
| `GET /booking-url` (always `{"booking_url": null}`) | **retired (deprecated, 29 Oct 2026)**: no replacement, Interviews has no public booking page in Hub. It still answers until removal is scheduled (retire list in `../data/v1-v2-gap-audit.md`) |
