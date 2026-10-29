# Online Training API v2

Base path: `/api/v2/online-training/`. Portal key `online-training`. Routes: `routes/api/online-training.php`. Controllers: `app/Http/Controllers/Api/OnlineTraining/`. Resources: `app/Http/Resources/Api/OnlineTraining/`. Webhooks: `app/Services/OnlineTraining/OtWebhooks.php`. Tests: `tests/Feature/Api/OnlineTrainingApiV2Test.php`, `tests/Feature/Api/OnlineTrainingApiV2WebhooksTest.php`.

This is the final v2 contract (phase 2). The old v1 HB Portal client API (`/api/...`, `routes/api/legacy`) is unchanged and keeps working. v2 has no external users, so it changed freely.

## 1. How it works

* **Authentication.** `POST /api/v2/auth/token` with the API key returns an `access_token`; send it as `Authorization: Bearer <access_token>`. A client with no Online Training account gets `403 portal_unavailable`.
* **Candidates belong to Hub.** A candidate is identified everywhere by `candidate_ref`, the uuid of the Hub core API (`/api/v2/hub/candidates`, see `../08-hub-core-candidates-api.md`). The portal's integer candidate id never appears in a path, body, response or webhook. Candidates are created and edited only in the Hub core API; this API lists the ones that have online training, reads their training and assigns courses.
* **Not found.** A malformed `candidate_ref`, an unknown one and another client's candidate are all `404 not_found`. A candidate that exists in Hub but has no HB Portal record yet is `404` on every read (there is no training to read); assigning courses to it creates the record (section 4.3).
* **Dates** are ISO 8601 UTC with `Z`, for example `2026-09-01T09:00:00Z`.
* **Credits** are units, not money, and are numbers that can have a fraction (`100`, `2.5`). Money is integer pence with `currency: "GBP"` and a name ending `_pence` (only the credit packages carry money).
* **Ids** are integers (`course_id`, `module_id`, transaction `id`, account `id`) except `candidate_ref`, which is a uuid string.

### Response shapes

* One resource: `{ "data": { ... } }`.
* A collection: `{ "data": [ ... ], "meta": { "page", "per_page", "total", "last_page", "from", "to" }, "links": { "first", "last", "prev", "next" } }`. Query `page` (default 1) and `per_page` (default 25, at most 100). Lists the portal builds whole (courses, modules, results, practical results) are paged in the same shape.
* Errors: `{ "error": "snake_case_code", "message": "...", "details": { ... }?, "request_id": "..." }`, with the same id in the `X-Request-Id` header (quote it to support). `details` is only present when there is something to point at.
* Every authenticated answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`: the key's hourly limit (1000 calls an hour by default) is the only limit on this portal, shared by every token of the key. There is no per-minute limit; the token calls (`/auth/token`, `/auth/refresh`) have their own 10-a-minute limit.
* **Sorting and paging.** Every list takes `page` and `per_page` and, where it has sort fields, `sort=field` or `sort=-field` (one field). Sort fields: candidates `first_name`, `last_name`, `email`, `expires_at`; courses `name`, `group`; modules `course_name`, `module_id`, `assigned_at`, `completed_at`, `expires_at`; results `course_name`, `status`, `assigned_at`, `completed_at`, `expires_at`; practical results `course_name`, `assigned_at`, `completed_at`, `expires_at`. Credit transactions have a fixed order (newest first) and cannot be sorted. An unknown sort field is `422` on `sort`. Date ranges (`expires_from`, `expires_to`) are whole UTC days.

| HTTP | `error` | When |
| --- | --- | --- |
| 401 | `unauthenticated` | no `Authorization: Bearer` header |
| 401 | `invalid_token` | the access token is unknown, expired or revoked |
| 403 | `insufficient_scope`, `key_inactive`, `ip_not_allowed`, `portal_unavailable` | key problems |
| 402 | `insufficient_credits` | an assignment that charges at assignment could not be paid. In Online Training the amounts are in `details`: `{ "error": "insufficient_credits", "message": "...", "details": { "needed": 3, "available": 1 }, "request_id": "..." }` (credits). Practical Training puts a top-level `available` object in the body instead, and Virtual BLS answers `payment_required` with a `payment_url`: see the errors guide |
| 404 | `not_found` | unknown route, candidate or course result |
| 409 | `idempotency_conflict` | the `Idempotency-Key` was used with a different body |
| 422 | `validation_failed` | invalid input; `details` is `{ field: [messages] }` |
| 422 | `no_certificates` | the certificate request matches no completed course |
| 429 | `rate_limited` | over the key's hourly limit (`Retry-After`) |

### Idempotency

`POST /candidates/{candidate_ref}/emails` accepts an `Idempotency-Key` header (stored 24 hours per key). The same key with the same body returns the first answer with header `Idempotent-Replayed: true`; the same key with a different body is `409 idempotency_conflict`. The only other write, `PUT .../courses`, sets an exact list of courses, so repeating it changes nothing.

## 2. Scopes

A scope is `online-training:{resource}:{read|write}`. `online-training:*` covers the portal and `*` covers everything.

| Scope | Endpoints |
| --- | --- |
| `online-training:account:read` | `GET profile`, `GET dashboard` |
| `online-training:credits:read` | `GET credits`, `GET credits/transactions` |
| `online-training:courses:read` | `GET courses` |
| `online-training:candidates:read` | `GET candidates`, `GET candidates/{candidate_ref}` |
| `online-training:candidates:write` | `PUT candidates/{candidate_ref}/courses` |
| `online-training:results:read` | `GET .../modules`, `GET .../results`, `GET .../results/{course_id}`, `GET .../practical-results` |
| `online-training:certificates:read` | `GET .../certificate` |
| `online-training:emails:write` | `POST .../emails` |

## 3. Account endpoints

### GET /profile

`{ "data": { "id": 1001, "name": "Acme Agency", "credits": 100, "training_charge": "client", "shares_credits_with": null } }`. `id` is the account id (integer). `training_charge` is who pays by default: `client` or `candidate`. `shares_credits_with` is the account id of the pool owner when the balance is shared, else null. `credits` is the number stored on this account itself: when `shares_credits_with` is set the credits that can actually be spent are the pool owner's, so read `balance` of `GET /credits` instead (code and docs agree here; the two fields can differ for a sharing account). Scope `online-training:account:read`.

### GET /dashboard

```json
{ "data": {
  "tiles": { "total": 12, "up_to_date": 9, "expiring_soon": 2, "expired": 1, "updated_at": "2026-10-28T02:30:00Z" },
  "compliant_pct": 75,
  "needs_attention": [ { "candidate_ref": "9f1c...", "name": "Ann Lee", "detail": "Nurse", "status": "expired" } ],
  "recent_activity": [ { "type": "completed", "description": "Ann Lee completed Fire Safety", "at": "2026-10-27T10:00:00Z", "candidate_ref": "9f1c..." } ]
} }
```

`status` is `expired`, `expiring_soon` or `not_completed`. The tiles are the stored statistics Hub shows, so the two always agree.

### GET /credits

```json
{ "data": { "balance": 100, "used_this_month": 5, "packages": [
  { "id": 1, "credits": 10, "price_pence": 5000, "vat_pence": 1000, "total_pence": 6000, "currency": "GBP" } ] } }
```

Credits are bought in Hub; the API has no top-up call.

### GET /credits/transactions

Query: `type` (`all`, `credit`, `debit`), `created_from`, `created_to` (`Y-m-d`, UK dates), `page`, `per_page`. Newest first.

```json
{ "data": [ { "id": 41, "created_at": "2026-10-05T12:31:00Z", "description": "Credits used", "amount": 5, "is_credit": false,
              "balance": 95, "candidate_ref": "9f1c...", "candidate_name": "Ann Lee" } ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 }, "links": { "first": "https://…?page=1", "last": "https://…?page=1", "prev": null, "next": null } }
```

`amount` is credits and always positive; `is_credit` is true for credits added. `candidate_ref` and `candidate_name` are null for a movement that belongs to no candidate. When the account shares a pool, only the pool's top-ups and the charges of the account's own candidates are listed.

### GET /courses

The courses the account may assign. Query: `search` (part of the name), `page`, `per_page`. Each: `{ "id": 12, "name": "Fire Safety", "group_id": 1, "group": "Standard Training Pack" }`.

## 4. Candidate endpoints

### 4.1 GET /candidates

The account's unarchived candidates, ordered by first name, last name. Query: `search` (every word matches first name, last name or email), `candidate_ref`, `status` (`up_to_date`, `expiring_soon`, `expired`, `not_completed`; only candidates with courses), `enrolled` (`true` = has courses, `false` = none), `course_id` (has that course assigned), `expires_from`, `expires_to` (`Y-m-d`, on `expires_at`), `page`, `per_page`. A `candidate_ref` that is unknown or belongs to another client returns an empty list.

Each item:

| Field | Meaning |
| --- | --- |
| `candidate_ref` | the Hub uuid |
| `first_name`, `last_name`, `email`, `phone` | identity (read only; edit in the Hub core API) |
| `job_role`, `client_record_id` | as recorded |
| `account_status` | `active` or `pending` (login not activated yet) |
| `training_status` | `up_to_date`, `expiring_soon`, `expired`, `not_completed`, or null when no courses are assigned |
| `courses_assigned`, `courses_completed`, `courses_expired` | counters |
| `paid_by` | `client` or `candidate` |
| `renewal_mode` | `auto` or `manual` |
| `completed_at` | when the latest course was completed, or null |
| `expires_at` | when the earliest completed course expires, or null |

### 4.2 GET /candidates/{candidate_ref}

`data` is the item above plus `summary` (`total`, `completed`, `needs_renewal`, `expiring_soon`, `not_started`) and `courses`, a list of course results (section 5.2).

### 4.3 PUT /candidates/{candidate_ref}/courses

Scope `online-training:candidates:write`. Sets the exact list of the candidate's courses: courses in the list are added, assigned courses not in it are removed (history is kept and nothing is refunded). Settings left out keep the candidate's current ones (a new candidate starts from the account's defaults).

| Field | Rules |
| --- | --- |
| `course_ids` | array of integers; required unless `candidate_group_id` is sent; `[]` removes every course. Every id must be in the account's `GET /courses`, else `422` on `course_ids` and nothing is written |
| `candidate_group_id` | integer, one of the account's active candidate groups. When `course_ids` is left out, the group's courses (group placeholders expanded, limited to allowed courses) are assigned. Also saved on the candidate |
| `training_charge` | `client` or `candidate`: who pays for the training |
| `renewal_mode` | `auto` or `manual` |
| `renew_training` | boolean, the old v1 flag: true puts the candidate on automatic renewal (`renewal_mode: auto`, unless `renewal_mode` is sent) and sets renew on expiry |
| `send_reminders` | boolean, renewal reminder emails |
| `framework_id`, `fixed_renewal` | only when the account lets candidates choose them (otherwise ignored, as in Hub) |
| `send_activation_email` | boolean, default true. Used only when this call has to create the candidate's HB Portal record (below); false creates it without emailing the activation link |

**A Hub candidate with no HB Portal record yet.** The call creates the record exactly as the Hub pages do (`CourseAssignment::createCandidate`: login, training user, defaults of the account), or adopts the account's candidate that has the same email, points the Hub candidate at it and keeps the `candidate_ref` unchanged. The courses are checked before anything is created, so a `422` leaves nothing behind.

Charging: by default (`online-training.credits.charge_on_start`) agency-paid credits are taken when the candidate starts a course group, so `credits_charged` is normally 0. When the account is set to charge at assignment, an unaffordable assignment answers `402 insufficient_credits` and writes nothing (a record created in the same call stays, without courses).

Response `200`:

```json
{ "data": { "candidate_ref": "9f1c...", "added_course_ids": [12], "removed_course_ids": [], "credits_charged": 0,
            "candidate": { "candidate_ref": "9f1c...", "courses_assigned": 1, "renewal_mode": "manual" } } }
```

`candidate` has every field of section 4.1. The "courses assigned" email is sent to the candidate for the added courses, as in Hub.

## 5. Results, certificate and emails

### 5.1 GET /candidates/{candidate_ref}/modules

Scope `online-training:results:read`. The enabled modules (tests) of the assigned courses, with the candidate's progress, for courses with no completion on record or whose last completion expired more than 56 days ago (the query of the v1 `training-modules` call, `TrainingQueries::RENEWAL_START` = 56 days). A course that is completed and in date, or expired less than 56 days ago, is therefore not listed: the older text said "within the renewal window", which the code does not do. Each: `course_id`, `course_name`, `module_id`, `description`, `status` (`in_progress`, `renewal_required`, `failed`, `reset`, `waiting`), `assigned_at`, `completed_at`, `expires_at` (null when empty).

### 5.2 GET /candidates/{candidate_ref}/results

Scope `online-training:results:read`. Query `scope`: `assigned` (default) lists the assigned courses; `unassigned` lists courses completed in the past that are no longer assigned (one row per course, from its latest completed result). Each result:

```json
{ "course_id": 12, "course_name": "Fire Safety", "group": "Standard Training Pack", "status": "completed", "grade": 1,
  "assigned_at": "2026-08-31T09:00:00Z", "completed_at": "2026-09-01T09:00:00Z", "expires_at": "2027-09-01T09:00:00Z", "certificate_available": true }
```

`status`: `completed`, `expiring_soon` (inside the account's warning window), `expired` or `not_completed`. `grade` is 0 to 1 for a completed course, else null.

### 5.3 GET /candidates/{candidate_ref}/results/{course_id}

One assigned course's result (the shape above in `data`). `404 not_found` when the course is not assigned to the candidate (v1 answered 204).

### 5.4 GET /candidates/{candidate_ref}/practical-results

Scope `online-training:results:read`. The practical (CSTF) training results: the sessions attended by the candidate of the same email in the Practical Training account, then the candidate's own course results. Query `scope`: `assigned` (default) or `unassigned`. Each: `course_id`, `course_name`, `practical` (true for a practical session), `status` (`completed`, `not_completed`), `grade` (0 to 1 or null), `assigned_at`, `completed_at`, `expires_at`. The result is the same list the v1 `training-results/{uuid}/practical` gave (the names of the practical courses are the CSTF names).

### 5.5 GET /candidates/{candidate_ref}/certificate

Scope `online-training:certificates:read`. A PDF (`application/pdf`) of the combined certificate. Query `type`: `current` (default), `assigned`, `all`, `excl-expired`, `incl-expired`, `range` (needs `date_from` and `date_to`, `Y-m-d`), `course` (needs `course_id`), `care`, `cstf`. `422 no_certificates` when nothing matches.

### 5.6 POST /candidates/{candidate_ref}/emails

Scope `online-training:emails:write`. `Idempotency-Key` supported (at most 255 characters, a longer one is `422`). Body `email_type`: `training_reminder` (sent to the candidate with the account's reminder wording and an opt-out link; `422` on `email_type` when they have no email) or `course_completion_reminder` (the email lists the incomplete courses; `422` on `email_type` when there are none or the candidate has no email). Each successful call sends one email and nothing limits how often you may call, so use the idempotency key on retries. The answer says the email was queued, not that it was read. Response: `{ "data": { "email_type": "training_reminder", "message": "Training reminder sent." } }`; the second type adds `incomplete_courses`.

## 6. Webhooks

Register an endpoint with `POST /api/v2/webhooks` (scope `account:webhooks:write`; listing endpoints, events and deliveries needs `account:webhooks:read`; testing and redelivering need `account:webhooks:write`) and pick events named `online-training.{event}`. Every delivery is signed (`X-Hub-Signature`, `X-Hub-Timestamp`, `X-Hub-Event`) like all Hub webhooks. A body is `{ "event_id", "event_type", "occurred_at", "data" }`: `event_id` is a uuid (the same on a redelivery, so ignore ids you have handled), `occurred_at` is when Hub queued the event, UTC with `Z`. A delivery is retried up to 5 times (pauses of 60, 300, 900 and 3600 seconds) and an endpoint that fails 25 deliveries in a row is switched off; the full contract is in `../guides/10-webhooks.md`. Bodies carry the `candidate_ref`, course ids and names, statuses, dates and the grade, and no name, email or other personal data. A failure to queue an event never breaks the action that caused it.

| Event | When it is queued | `data` |
| --- | --- | --- |
| `online-training.course.assigned` | courses were added to a candidate: by the API, the Hub pages, imports, bulk assignment, or an e-learning account made for a booking | `candidate_ref`, `course_ids`, `courses` (`course_id`, `course_name`), `assigned_at` |
| `online-training.course.completed` | a candidate passed a course (learner result, or staff marking it complete). This is the fact the v1 course callback reported | `candidate_ref`, `course_id`, `course_name`, `status` (`completed`), `assigned_at`, `completed_at`, `expires_at`, `grade` (0 to 1) |
| `online-training.training.completed` | every assigned course of the candidate is now complete (the v1 training-complete callback) | `candidate_ref`, `status` (`complete`), `courses_assigned`, `courses_completed`, `completed_at`, `expires_at` |
| `online-training.training.expiring` | the renewal reminder job emailed a candidate (on automatic renewal, reminders on) whose training is due for renewal | `candidate_ref`, `status` (`expiring_soon`), `expires_at` |
| `online-training.training.expired` | the same job emailed a candidate whose renewal date has passed | `candidate_ref`, `status` (`expired`), `expires_at` |
| `online-training.certificate.issued` | staff supplied a combined certificate for the candidate | `candidate_ref`, `type`, `issued_at` |

Limits worth knowing: there is no `course.started` event because Hub records the start of a course group's access, not of a single course. `training.expiring` and `training.expired` follow the existing reminder job, so they only cover candidates who receive those reminders, and only once the job is switched on (`online-training.schedule.candidate_renewals`). The v1 callback itself (`api_callback`, `callback_url`) is unchanged and still produced by the legacy code.

## 7. v1 to v2 mapping

| v1 (`/api`) | v2 (`/api/v2/online-training`) | Change |
| --- | --- | --- |
| `GET /candidates` | `GET /candidates` | by `candidate_ref`; paged; filters `search`, `status`, `enrolled`, `course_id` |
| `POST /candidates` | `POST /api/v2/hub/candidates`, then `PUT /candidates/{candidate_ref}/courses` | identity in Hub; `courses`, `candidate_group_id`, `training_charge`, `send_activation_email`, `renew_training` go on the assign call |
| `GET /candidates/{uuid}` | `GET /candidates/{candidate_ref}` | adds `summary` and `courses` |
| `PATCH /candidates/{uuid}` | `PATCH /api/v2/hub/candidates/{candidate_ref}` for identity; `PUT .../courses` for courses, group, payer, renewal | identity is Hub's |
| `GET /training-list` | `GET /courses` | paged, `search` |
| `GET /training-modules/{uuid}` | `GET /candidates/{candidate_ref}/modules` | typed, statuses are codes |
| `GET /training-results/{uuid}` | `GET /candidates/{candidate_ref}/results` | typed fields, ISO UTC dates |
| `GET /training-results/{uuid}/unassigned` | `GET .../results?scope=unassigned` | |
| `GET /training-results/{uuid}/practical` | `GET .../practical-results` | |
| `GET /training-results/{uuid}/practical/unassigned` | `GET .../practical-results?scope=unassigned` | |
| `GET /training-results/{uuid}/course/{course}` | `GET .../results/{course_id}` | 404 instead of 204 |
| `GET /training-results/{uuid}/certificate[/{selector}[/{course}]]` | `GET .../certificate?type=&course_id=` | `incl_expired` is `incl-expired`, `all_excl_expired` is `excl-expired`, `course/{id}` is `type=course&course_id=` |
| `callback_url` course callback | webhook `online-training.course.completed` | the same fact, queued in Hub's webhook system |
| `callback_url` training-complete callback | webhook `online-training.training.completed` | |

Removed from v2 on purpose: `POST /candidates` (candidate creation) and `PUT /candidates/{id}/custom-fields`. Custom fields are the client's Hub candidate fields (their values live in Hub), so they belong to the Hub core API, which does not expose them yet.
