# Practical Training API v2: reference

Base URL: `https://hub.hbcompliance.co.uk/api/v2/practical-training/`. Portal key `practical-training`. Every call needs `Authorization: Bearer <access_token>` (from `POST /auth/token` with the API key, body `api_key`) and `Accept: application/json`. The client must have a Practical Training account, otherwise every call is `403 portal_unavailable`. Everything is scoped to the key's client. Candidates are managed in the Hub core API (`/api/v2/hub/candidates`, see `../08-hub-core-candidates-api.md`); this API only refers to them by `candidate_ref`. `GET /auth/me` and `POST /auth/revoke` exist only at `/api/v2/auth/`.

## 1. Conventions

* A single resource is `{ "data": { ... } }`. A list is `{ "data": [ ... ], "meta": { "page", "per_page", "total", "last_page", "from", "to" }, "links": { "first", "last", "prev", "next" } }`. Courses are a short fixed list: one page that holds every item.
* Errors are `{ "error": "<code>", "message": "...", "details": { "field": ["message"] } }`; `details` only on `validation_failed`. Codes: `invalid_token` 401, `key_inactive` 403, `ip_not_allowed` 403, `insufficient_scope` 403, `portal_unavailable` 403, `invites_not_enabled` 403, `insufficient_credits` 402, `not_found` 404, `conflict` 409, `idempotency_conflict` 409, `validation_failed` 422, `booking_rejected` 422, `no_places_left` 422, `rate_limited` 429, `service_unavailable` 503 (a refund that is due could not be made by the payment provider; nothing was changed, retry).
* Another client's record is always `404 not_found`. An unknown or other-client `candidate_ref` in a request body or filter is `422 validation_failed` with the error on `candidate_ref`. (No path in this API contains a `candidate_ref`.)
* Pagination: `page` (default 1), `per_page` (default 25, 1 to 100) on every list. Search is `search`. Date ranges are `{field}_from` and `{field}_to` (`YYYY-MM-DD`, or an ISO 8601 date-time with `Z` or an offset; a date-time without an offset is read as UTC). A date alone is a whole **UK calendar day**: `created_from=2026-07-07` starts at `2026-07-06T23:00:00Z` (UK midnight in British Summer Time) and `created_to=2026-07-07` ends at `2026-07-07T22:59:59Z`; in winter the day is the UTC day. The same applies to `start_date_from` and `start_date_to`, which are compared with the session's UK local start time. Sorting is `sort=field` or `sort=-field`.
* Dates and times: ISO 8601 with `Z` (`2026-10-28T19:53:24Z`). Every date-time is a true UTC instant, including session times: a session at 09:00 UK time is `2026-07-07T08:00:00Z` in British Summer Time and `2026-11-07T09:00:00Z` in winter (section 3).
* Money: integer pence in fields ending `_pence`, with a `currency: "GBP"` field beside it. **Credits are credit units, not money**: they stay plain numbers (`credits`, may be fractional such as `4.5`).
* Ids are integers, except `candidate_ref` (uuid string) and a hold, which is addressed by `hold_hash` (string).
* Candidate: always the `candidate_ref`, the same value as in the Hub core API. The integer HB Portal candidate id is never returned.
* `Idempotency-Key` header on every POST that creates something (`POST /training-events/{event}/hold`, `POST /bookings`, `POST /booking-invites`): within 24 hours the same key and body returns the original answer with `Idempotent-Replayed: true`; the same key with a different body is `409 idempotency_conflict`.
* Per-minute throttle `practical-training-api` (120 a minute) as before; the hourly per-key limit applies as everywhere.

## 2. Scopes

| Scope | Endpoints |
| --- | --- |
| `practical-training:account:read` | `GET /profile`, `GET /booking-link` |
| `practical-training:credits:read` | `GET /credits`, `GET /credits/transactions` |
| `practical-training:catalogue:read` | `GET /courses`, `GET /locations`, `GET /training-events`, `GET /training-events/{event}` |
| `practical-training:holds:write` | `POST /training-events/{event}/hold`, `DELETE /training-events/hold/{hash}` |
| `practical-training:bookings:read` | `GET /bookings`, `GET /bookings/no-shows`, `GET /bookings/{booking}`, `GET /bookings/{booking}/certificate`, `GET /booking-invites`, `GET /booking-invites/{invite}` |
| `practical-training:bookings:write` | `POST /bookings`, `POST /bookings/{booking}/cancel`, `POST /booking-invites`, `DELETE /booking-invites/{invite}` |

`practical-training:*` and `*` cover all. **Moved:** credits and the ledger were under `account` and are now under `credits` (`account:read` no longer opens them). Keys copied from the old portal have `practical-training:*`, so they are unaffected. Missing scope: `403 insufficient_scope`. There is no endpoint to create a candidate (use `POST /api/v2/hub/candidates`) or to top up credits.

## 3. Sequence of calls

A booking is made in three calls, and a candidate must exist in the Hub core API first.

1. `GET /training-events` to find a session (filter by course, location and date; `available_only=true` hides full sessions). Check `remaining_slots` and `cost_inc_vat_pence`.
2. `GET /credits` to see whether the account can pay with `credits` or `balance` (invoicing and `candidate_pays` do not need funds).
3. `POST /training-events/{event}/hold` holds one place for 30 minutes and returns the `hold_hash`. A hold does not take a seat or charge anything.
4. `POST /bookings` with the `hold_hash`, the `candidate_ref`, the `pay_option` and the agency contact. This takes the seat, takes credits or balance for `credits` and `balance`, sends the confirmation emails and queues `practical-training.booking.created`.
5. Receive the webhook, or read the booking with `GET /bookings/{booking}`.
6. Cancel with `POST /bookings/{booking}/cancel` if needed. Download the certificate with `GET /bookings/{booking}/certificate` once `certificate_available` is true.

If the candidate decides not to book, release the hold with `DELETE /training-events/hold/{hash}` (an account may hold one place at a time). To let a candidate choose their own session instead, invite them (`POST /booking-invites`, only for accounts that have invitations switched on).

Things to know before you call:

* Holding does not reserve a seat. The seat is taken when the booking is created, so a booking can still be refused (`422 no_places_left`) if the session filled in the meantime, even with a live hold.
* All date-times, in responses and in webhooks, are UTC instants with a `Z`. Session times (`start_date`, `end_date`) are the session's UK local time converted to UTC, so they are an hour earlier than the clock in the UK during British Summer Time (09:00 on 7 July is `2026-07-07T08:00:00Z`) and equal to it in winter. Convert to `Europe/London` to show them. A time that does not exist on the March clock change, or that happens twice on the October one, is stored as UK wall-clock text and is read as the time after the change in March and as the second (GMT) occurrence in October.
* Cancelling refunds what is due to the original payment method, and the booking becomes `refunded` when it did. `POST /bookings/{booking}/cancel` releases the seat, sends the cancellation email and: returns the credit (`pay_option` `credits`) or the price (`balance`) when the session is 48 hours or more away, or inside 48 hours while the account still has a free cancellation this month; refunds a card payment (`candidate_pays`) in full 48 hours or more ahead, 20% when the candidate has already used the online training, and nothing inside 48 hours; returns nothing for `invoice` and free bookings (status `cancelled`). Otherwise the booking is `cancelled` and the cost is logged on it. The booking detail shows `refund` (`method`, `amount_pence` and `currency` or `credits`, `partial`). A booking is refunded at most once.
* The call that charges: `POST /bookings` with `pay_option` `credits` (one booking credit for the course) or `balance` (the session price from the booking balance), taken at once in the same transaction. `invoice` takes nothing and needs invoicing on the account and the price within its credit limit. `candidate_pays` leaves the booking `pending` until the candidate pays the `payment_url`; an unpaid one is set to `abandoned` after two days or six hours before the session, whichever is earlier (when the scheduled housekeeping is running). Too few credits or too little balance is `402 insufficient_credits` (`available` shows `pays_with`, `balance_pence`, `credits`, `price_pence`); invoicing that is not allowed, or a price over the credit limit, is `422 booking_rejected` with the reason in `message`.
* Personal data: no endpoint returns or accepts a candidate's name, email, phone or job role. Bookings and invitations carry `candidate_ref` and, on a booking, the name as written on it (`candidate_name`). The attendee's details are taken from the Hub candidate when you book; add anything missing with `PATCH /api/v2/hub/candidates/{candidate_ref}`.
* Idempotency: `Idempotency-Key` is optional (at most 255 characters). With it, the same key, path and body within 24 hours returns the first successful answer with `Idempotent-Replayed: true`; a different body is `409 idempotency_conflict`. Only successful answers are remembered. Without it, repeating a successful `POST /bookings` fails because its hold is gone, repeating a hold gives `409 conflict`, and repeating an invitation inside the month gives `409 conflict`.

## 4. Endpoints

Every endpoint is described in full (every field, example and error) in the OpenAPI document `openapi/hub-v2.json`, which is generated from the code. This section is the summary.

### 4.1 Account

`GET /profile` (`account:read`): `id` (the Hub client id), `name`, `contact_name`, `email`, `notify_email`, `client_active`.

`GET /booking-link` (`account:read`): `booking_url` (the public booking page of the account, not one-time; null when the account has no Sage contact id) and `sage_contact_id`. This is what the old `GET /api/tdta/getBookingLinkForClient/{client_id}` returned (the Sage contact id), with the full URL added. The old public fallback to a standard open link for an unknown client is not offered.

`GET /credits` (`credits:read`): `booking_credits` (list of `course_id`, `course_name`, `credits`; only courses with credits left; one credit is one place on the course and may be fractional), `booking_balance_pence` (may be zero or negative), `currency`. There is no top-up call.

`GET /credits/transactions` (`credits:read`). Query: `wallet` (`booking_balance` or a course id), `type` (`deposit`, `withdraw`), `created_from`, `created_to`, `sort` (`id`, `created_at`), `page`, `per_page`. Confirmed movements only, newest first. Row: `id`, `type`, `wallet` (`booking_balance` or the course id as text), `amount_pence` and `currency` (money wallet, otherwise null), `credits` (credit wallet, otherwise null), `description`, `booking_id`, `created_at`. Amounts are always positive.

### 4.2 Catalogue and holds

`GET /courses` (`catalogue:read`): `id`, `name`, `client_rate_pence` (0 when the account has no own rate), `currency`, `duration_hours`. One page holds every course; `sort` is `course_name`.

`GET /locations`. Query: `search`, `sort` (`location_name`). Rows: `id`, `name`, `address`.

`GET /training-events`. Query: `course_id`, `location_id`, `start_date_from`, `start_date_to`, `available_only`, `sort` (`start_date` default, `remaining_slots`, `cost`; `-` prefix descending). Sessions that are active, not hidden, in the future, and public or made for the account. Row: `id`, `course` (`id`, `name`), `location` (`id`, `name`, `address`) or null, `start_date`, `end_date`, `remaining_slots`, `cost_inc_vat_pence` (the account's rate for the course when it has one, otherwise the session price), `currency`. `GET /training-events/{event}` adds `trainer` (`id`, `name`) or null. Not open to the account: `404 not_found`.

`POST /training-events/{event}/hold` (`holds:write`, `Idempotency-Key`): `201` with `hold_hash`, `expires_at`, `expires_in_seconds`, `training_event` (`id`, `course_name`, `location_name`, `start_date`). `409 conflict` when a place is already held (the body also carries `hold`, the existing hold). `422 no_places_left` when the session is full. `404 not_found` for a session the account cannot book. A hold counts as expired from `expires_at`; the scheduled clean-up (about every five minutes) deletes it and sends `slot_hold.expired`.

`DELETE /training-events/hold/{hash}` (`holds:write`): `{ "data": { "hold_hash", "released": true } }`; unknown, used or another account's hold: `404 not_found`.

### 4.3 Bookings

Booking row: `id`, `candidate_ref` (the Hub candidate with the booking's HB Portal candidate id, else with its email; **null** when the account has no such Hub candidate), `candidate_name` (the name on the booking), `course` (`id`, `name`), `location` or null, `training_event_id`, `start_date`, `end_date`, `booking_status` (`pending`, `booked`, `rescheduled`, `cancelled` (nothing refunded), `refunded` (cancelled and money or credit paid back to the original payment method), `abandoned`), `pay_status` (`completed`, `refunded`, or null), `pay_option` (`credits`, `balance`, `inv`, `cc`, `free`), `booked_by` (`Agency` for bookings made by the account), `cost_pence`, `currency`, `attendance` (`passed`, `present`, `absent` or null; the first training day), `certificate_available` (any day `passed` or `present`; the webhook `booking.certificate_available` is sent when it becomes true), `created_at`. The detail (`GET /bookings/{booking}`, and the answers of create and cancel) adds `trainer` (`id`, `name`) or null and `refund` (null unless the booking was cancelled with money or credit returned: `method` `credits`, `balance` or `card`, `amount_pence` and `currency` for balance and card, `credits` for credits, `partial`); the answer of create adds `payment_url` for `candidate_pays`. Only `booked` and `rescheduled` bookings hold a seat.

`GET /bookings` and `GET /bookings/no-shows` (`bookings:read`). Query: `status` (one or many; unknown values are ignored), `course_id`, `location_id`, `candidate_ref`, `start_date_from`, `start_date_to`, `created_from`, `created_to`, `upcoming`, `past` (booleans, UK time), `attendance` (`passed`, `present`, `absent`), `search` (name or email on the booking), `sort` (`created_at`, `start_date`, `status`; `-` prefix descending; default `-created_at`), `page`, `per_page`. `no-shows` is the same list with `attendance=absent`.

`POST /bookings` (`bookings:write`, `Idempotency-Key`). Body:

| Field | Rule |
| --- | --- |
| `hold_hash` | required; a live hold of this account (unknown, used or expired: `422` on `hold_hash`) |
| `candidate_ref` | required, uuid; a Hub candidate of this account (`422` on `candidate_ref` otherwise) |
| `pay_option` | required: `credits`, `balance`, `invoice` (or `inv`), `candidate_pays` |
| `agency_contact_name` | required, at most 150 characters |
| `agency_contact_email` | required, valid email, at most 255 characters |
| `agency_email` | optional, valid email; the agency confirmation goes here, else to the account's notification address |

The attendee's first name, last name, email, phone and job role (the Hub candidate's first role) come from the Hub candidate. A candidate without a first name, an email or a phone number is `422` on `candidate_ref`. A booking is made exactly as the Bookings page makes it (`BookingService::create`): the seat is taken, credits or balance are debited for `credits` and `balance`, and the confirmation emails are sent. The HB Portal account is provisioned afterwards by the existing scheduled job, as for every booking. `201` with the booking detail. Too few credits or too little balance: `402 insufficient_credits`; a full session: `422 no_places_left`; invoicing that is not allowed, a closed session, or a candidate who already has a pending, booked or rescheduled booking on the session (matched on email): `422 booking_rejected` with the reason in `message`; the hold is kept.

`POST /bookings/{booking}/cancel` (`bookings:write`): returns the booking with its final status (`cancelled`, or `refunded` when something was paid back) and `refund`. The refund rules are in section 3. A booking that does not hold a seat (cancelled, refunded, pending, abandoned) or whose session has started: `409 conflict`. A card refund that is due but that the payment provider refused: `503 service_unavailable`, the booking is untouched and the call can be repeated. A repeat after success is `409 conflict` and never refunds twice.

`GET /bookings/{booking}/certificate` (`bookings:read`): the attendance certificate as `application/pdf`; before any training day is `passed` or `present`: `409 conflict`.

### 4.4 Booking invitations

A booking invitation emails a candidate a one-time link (valid 8 weeks) to pick a session and book a place the account pays for. The API does what the Invites page does: the course is the one set for the account, the candidate picks the session, and the account pays with booking credits or balance when the candidate books. Only accounts that have invitations switched on; for others every invitation endpoint is `403 invites_not_enabled`. Editing or resending does not exist on the page and is not offered.

Invitation row: `id`, `candidate_ref` (the Hub candidate with the invited email; null when none), `candidate_name`, `status` (`unsent`, `waiting`, `used`), `course_id`, `contact_name`, `contact_email`, `url` (while it still works, otherwise null), `expires_at`, `booking_id` (set once used), `created_at`.

`GET /booking-invites` (`bookings:read`). Query: `state`, `candidate_ref`, `search`, `created_from`, `created_to`, `used_from`, `used_to`, `sort` (`id`, `created_at`), `page`, `per_page`. Newest first.

`GET /booking-invites/{invite}` (`bookings:read`): one invitation; another account's, or a withdrawn one: `404 not_found`.

`POST /booking-invites` (`bookings:write`, `Idempotency-Key`). Body: `candidate_ref` (required, uuid, a Hub candidate with an email address), `contact_name` (at most 150 characters), `contact_email` (valid email, at most 255) (optional: the person at the account who is copied in). The invitation is created and sent at once, and `booking_invite.sent` is queued. `201` with the invitation. `402 insufficient_credits` when the account cannot pay for the place (booking credits for accounts that pay with credits, otherwise booking balance; the body carries `available` with `pays_with`, `balance_pence`, `credits`); nothing is made. `409 conflict` when the candidate was invited in the last month (unless that booking was cancelled): no email is sent and nothing is kept. Nothing is charged by this call.

`DELETE /booking-invites/{invite}` (`bookings:write`): withdraws the invitation; its link stops working at once and no email or webhook follows. `{ "data": { "id", "withdrawn": true } }`.

## 5. Worked example: hold, book, receive the webhook, cancel

All calls carry `Authorization: Bearer <access_token>` and `Accept: application/json`. The candidate already exists in the Hub core API with a first name, email address and phone number.

**1. Hold a place** on session 44.

```
POST /api/v2/practical-training/training-events/44/hold
Idempotency-Key: 6f2f3b9e-0c1d-4c1e-9d55-2a1f7a5e8b01
```

```json
{
  "data": {
    "hold_hash": "k3Jf9QzP1xV7mW2nB8dR5tY0uLcA4sHe",
    "expires_at": "2026-10-28T20:23:24Z",
    "expires_in_seconds": 1800,
    "training_event": {
      "id": 44,
      "course_name": "Manual Handling",
      "location_name": "Leeds Training Centre",
      "start_date": "2026-11-07T09:00:00Z"
    }
  }
}
```

**2. Book the place** for the candidate, paying with a booking credit.

```
POST /api/v2/practical-training/bookings
Idempotency-Key: 0b8d1c5a-77a3-4d2a-b6f5-3c9e5d0a1f22
Content-Type: application/json
```

```json
{
  "hold_hash": "k3Jf9QzP1xV7mW2nB8dR5tY0uLcA4sHe",
  "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "pay_option": "credits",
  "agency_contact_name": "Alex Morgan",
  "agency_contact_email": "alex.morgan@riverside-care.example.com"
}
```

`201 Created`:

```json
{
  "data": {
    "id": 812,
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "candidate_name": "Jane Doe",
    "course": { "id": 1, "name": "Manual Handling" },
    "location": { "id": 3, "name": "Leeds Training Centre", "address": "12 Park Row, Leeds, LS1 5HD" },
    "training_event_id": 44,
    "start_date": "2026-11-07T09:00:00Z",
    "end_date": "2026-11-07T16:30:00Z",
    "booking_status": "booked",
    "pay_status": "completed",
    "pay_option": "credits",
    "booked_by": "Agency",
    "cost_pence": 4500,
    "currency": "GBP",
    "attendance": null,
    "certificate_available": false,
    "created_at": "2026-10-28T19:53:24Z",
    "trainer": { "id": 7, "name": "Sam Taylor" }
  }
}
```

One booking credit for the course was taken, the hold was removed, and the confirmation emails were sent to the candidate and the agency.

**3. Receive the webhook.** Hub sends `practical-training.booking.created` to every active endpoint that subscribed to it (verify `X-Hub-Signature` first):

```json
{
  "event_id": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "event_type": "practical-training.booking.created",
  "occurred_at": "2026-10-28T19:53:25Z",
  "data": {
    "booking_id": 812,
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "training_event_id": 44,
    "course_id": 1,
    "course_name": "Manual Handling",
    "location_name": "Leeds Training Centre",
    "start_date": "2026-11-07T09:00:00Z",
    "booking_status": "booked",
    "pay_option": "credits"
  }
}
```

A booking paid with credits has no separate `booking.confirmed` event: it is created already `booked`.

**4. Cancel** the booking.

```
POST /api/v2/practical-training/bookings/812/cancel
```

`200 OK`: the same booking object as in step 2 (inside `data`) with `"booking_status": "refunded"` and `"refund": { "method": "credits", "amount_pence": null, "currency": null, "credits": 1, "partial": false }`, because the session is more than 48 hours away and the credit goes back to the account. The seat is released and the candidate is emailed. Hub then sends one `practical-training.booking.cancelled` with `"booking_status": "refunded"` and the same `refund` in `data`. A second cancel call answers:

```json
{ "error": "conflict", "message": "Only a confirmed booking can be cancelled.", "request_id": "01M6..." }
```

## 6. Webhooks

Delivery, signature headers and retries are those of Hub webhooks (`/api/v2/webhooks`, scope `account:webhooks:*`): `X-Hub-Signature` is `sha256=` and the HMAC-SHA256 of `{X-Hub-Timestamp}.{raw body}` with the endpoint secret; a delivery is retried up to 5 times and an endpoint that fails 25 times in a row is switched off. Body: `event_id`, `event_type`, `occurred_at`, `data`. Event names are prefixed `practical-training.`. The `data` carries ids, names of the course and location, statuses and the `candidate_ref`, never a candidate's name or email. Every date in `data` and `occurred_at` is a UTC instant with a `Z` (section 3); money is pence. The older Practical Training endpoints (`/api/practical-training/v1/webhooks`) keep the old bodies with `candidate_name` and `candidate_email`; this document and the OpenAPI spec describe only the Hub (v2) bodies. Every event is documented field by field in `openapi/overrides/webhook-data-practical-training.json` (and so in the spec).

Booking events (`booking.created`, `booking.confirmed`, `booking.rescheduled`, `booking.cancelled`, `booking.attendance_marked`, `booking.no_show`, `booking.certificate_available`) share `data`: `booking_id`, `candidate_ref` (null when the account has no matching Hub candidate), `training_event_id`, `course_id`, `course_name`, `location_name`, `start_date`, `booking_status`, `pay_option`. They are sent for every booking of the account, however it was made (this API, the Bookings page, a booking link or an invitation).

| Event | When it is sent | Extra `data` fields |
| --- | --- | --- |
| `booking.created` | a booking record was created (it may still be `pending`) | none |
| `booking.confirmed` | a `pending` booking became `booked` (for example the candidate paid); not sent for bookings created already `booked` | none |
| `booking.rescheduled` | a booking was moved to another session | none |
| `booking.cancelled` | the status became `cancelled` or `refunded` (once per cancellation, with the final status) | `refund`: null, or `method`, `amount_pence` and `currency` (or `credits`), `partial` (never card details) |
| `booking.attendance_marked` | attendance was recorded for the last training day (once; also when Healthier Business resends the notifications) | `attendance` (`passed`, `present`, `absent`), `attendance_day` |
| `booking.no_show` | the last day was recorded `absent` (with `attendance_marked`) | `attendance`, `attendance_day` |
| `booking.certificate_available` | `certificate_available` on the booking became true (a training day was recorded `passed` or `present`, not only the last day), the last day was recorded `passed`, or a certificate purchase was paid or granted | attendance: `attendance`, `attendance_day`; purchase: `certificate_purchase_id` |
| `booking_invite.sent` | an invitation was sent | `invite_id`, `candidate_ref`, `course_id`, `invite_url` |
| `booking_invite.opened` | the candidate opened the link (the first time only) | `invite_id`, `candidate_ref`, `course_id`, `course_name` |
| `booking_invite.used` | the candidate booked with the link | `invite_id`, `candidate_ref`, `course_id`, `booking_id`, `training_event_id`, `course_name`, `start_date` |
| `balance.low` | a withdrawal took the booking balance from above the threshold (10000 pence) to the threshold or less, still above zero | `balance_pence`, `threshold_pence`, `currency` |
| `balance.depleted` | a withdrawal took the booking balance from positive to zero or below | `balance_pence`, `currency` |
| `credits.low` | a withdrawal took a course's credits from above the threshold (10) to the threshold or less, still above zero | `course_id`, `course_name`, `credits`, `threshold` |
| `credits.depleted` | a withdrawal took a course's credits from positive to zero or below | `course_id`, `course_name`, `credits` |
| `training_event.seats_low` | after a booking is completed, the session has 3 places or fewer left (sent for each such booking) | `training_event_id`, `course_name`, `location_name`, `start_date`, `remaining_slots`, `threshold` |
| `slot_hold.expired` | a held place expired unused (sent by the scheduled clean-up, up to about five minutes late) | `hold_hash`, `training_event_id`, `course_name`, `location_name`, `start_date`, `expired_at` |
| `webhook.test` | the test button; not one of the events you subscribe to and not in the spec | `message` |

Example (`booking.created`) is in section 5.

## 7. v1 to v2

The old API (`/api/practical-training/v1`, `/api/tdta`) keeps working unchanged with its own controllers and shapes.

| v1 | v2 |
| --- | --- |
| `POST /auth/token` (`hb_client_id` + `api_key`), `/auth/refresh` | `POST /api/v2/auth/token` and `POST /api/v2/auth/refresh`: one exchange for every portal, no per-portal auth routes; body `api_key` only (a Hub API key, which carries the scopes of the portals it may use) |
| `GET /auth/token-info`, `POST /auth/revoke` | `GET /api/v2/auth/me`, `POST /api/v2/auth/revoke` |
| `GET /profile` | `GET /profile`, wrapped in `data`, `id` unchanged (Hub client id) |
| `GET /credits` (`booking_money_balance` in pounds) | `GET /credits` (`booking_balance_pence`, scope `credits:read`); credits unchanged as units |
| `GET /transactions` (`amount`, `wallet`, `meta`) | `GET /credits/transactions` (`amount_pence` or `credits`, `description`, `booking_id`; `created_from`/`created_to`) |
| `GET /courses` (`client_rate` pounds) | `GET /courses` (`client_rate_pence`) |
| `GET /locations` (`per_page` up to 200, default 50) | default 25, up to 100 |
| `GET /training-events` (`cost_inc_vat` pounds; `date_from`/`date_to`; `sort_dir`) | `cost_inc_vat_pence`; `start_date_from`/`start_date_to`; `sort=-start_date` |
| `POST /training-events/{event}/hold` (`{hold_hash,...}` unwrapped; 409 `{message,hold_hash}`) | wrapped in `data`; 409 `conflict` with `hold`; `Idempotency-Key` |
| `GET /bookings` (`candidate` object with name, email, phone, job_role; `date_from`/`date_to`; default 20) | `candidate_ref` + `candidate_name`; `candidate_ref` filter; `start_date_from`/`start_date_to`; default 25 |
| `POST /bookings` (`first_name`, `last_name`, `email`, `phone`, `job_role`) | `candidate_ref` instead of those five; `pay_option` also accepts `invoice` |
| `POST /bookings/{booking}/cancel` (`{message, booking_status}`; no refund; session started `422`) | returns the booking in `data`, refunds what is due (`refunded` or `cancelled`, `refund`); every refusal is `409 conflict`, a failed card refund `503` |
| `POST /bookings` with too few credits (`422`) | `402 insufficient_credits`; a full session is `422 no_places_left` |
| `GET /bookings/{booking}/certificate` 422 | 409 `conflict` |
| `GET /api/tdta/booking-links/search` (`creation_date`, `usage_date`, `is_used`, `d/m/Y`) | `GET /booking-invites` (`created_from`/`created_to`, `used_from`/`used_to`, `state`, `Y-m-d`); plus create, read and withdraw |
| `GET /api/tdta/getBookingLinkForClient/{client_id}` (public) | `GET /booking-link` (authenticated, the key's own client) |
| `GET/POST/PUT/DELETE /webhooks...` (portal table) | `/api/v2/webhooks` (account-wide) |
| `GET /api/tdta/bookings/past\|upcoming\|search` | `GET /bookings?past=1`, `?upcoming=1`, `?start_date_from=&start_date_to=&search=` |
| public feeds (`trainingevents`, `gettrainingevents`, `gettdtaevents`, `upcoming-training-events`, `verify-training`) | not in v2 (unchanged, v1 only) |
| `GET /api/tdta/trainingstoday` | **retired (deprecated, 29 Oct 2026)**: an unauthenticated feed of today's sessions of every client, hidden ones included. Not in v2 and not to be built on; it still answers until removal is scheduled (see the retire list in `../data/v1-v2-gap-audit.md`) |
