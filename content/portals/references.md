# References API v2: reference

Base URL: `https://hub.hbcompliance.co.uk/api/v2/references/`. Portal key `references`. Every call needs `Authorization: Bearer <access_token>` (from `POST /auth/token` with the API key) and `Accept: application/json`. The client must have References, otherwise every call is `403 portal_unavailable`. Everything is scoped to the key's client. A reference request is about one candidate; the engine sends the emails and records the activity exactly as when a client works in Hub.

## 0. How a reference request works

A reference request asks one or more referees to vouch for one candidate. You create it for a candidate (`candidate_ref`) with `POST /requests`. You choose who gives the referee details: with `client_adds` you send the referees in the same call and each is emailed at once with a private link to the form; with `candidate_provides` the candidate is emailed a link to a public page (the `submission_url`) where they enter their referees, and each is then emailed automatically. A referee opens the link in their own browser and either submits the form or declines; there is no API call that answers for a referee. Hub tells you by webhook (`reference.submitted`, `reference.declined`, and `reference.all_completed` once enough references are in) and you read the outcome with `GET /requests/{uuid}`, `GET /referees/{uuid}` (answers and score) and `GET /referees/{uuid}/pdf`. While a referee has not answered you can chase them (`POST /requests/{uuid}/reminders` for everyone who is due, `POST /referees/{uuid}/reminder` for one), add a replacement or extra referee (`POST /requests/{uuid}/referees`), give more time (`POST /requests/{uuid}/extend`) or give up (`POST /requests/{uuid}/cancel`). A request that is not completed expires at `expires_at`.

A request has the status `pending` (no referee has been emailed yet), `in_progress`, `completed` (the number of references required is in), `cancelled` or `expired`. A referee has the status `pending`, `sent`, `opened`, `in_progress`, `completed`, `declined`, `expired` or `bounced`; the last four are final. Nothing in References uses credits: no call charges anything.

**Privacy.** A reference holds personal data of third parties: the referee's name, email and phone, what they wrote about the candidate and, if they declined, why. The API returns these to a key with the right scope, so store and show them with the care a written reference deserves. Webhooks never carry them: they carry uuids, the `candidate_ref` and counts only. A referee's private link to the form works as a credential, so the API never returns it (there is no `form_url`); use `POST /referees/{uuid}/reminder` to have it emailed to the referee again.

## 1. Conventions

* A single resource is `{ "data": { ... } }`. A list is `{ "data": [ ... ], "meta": { "page", "per_page", "total", "last_page", "from", "to" }, "links": { "first", "last", "prev", "next" } }`. Templates are a short fixed list: one page that holds every item.
* Errors are `{ "error": "<code>", "message": "...", "details": { "field": ["message"] } }`; `details` only on `validation_failed`. Codes: `invalid_token` 401, `insufficient_scope` 403, `portal_unavailable` 403, `not_found` 404, `idempotency_conflict` 409, `validation_failed` 422, `reference_request_refused` 422, `pdf_not_available` 404, and the state conflicts, all `409`: `request_not_cancellable`, `request_not_extendable`, `request_not_open`, `referee_already_added`, `referee_limit_reached`, `legacy_request_unanswered` and `reminder_not_sent`. A request in the wrong state is a `409` (the state, not your input, is the problem); a bad field, including a `collection_mode` of `both`, is `422 validation_failed`; there is no `402` in this portal because requests are not charged. `invalid_status` is no longer returned.
* Another client's record is always `404 not_found`, never `403`.
* Pagination: `page` (default 1) and `per_page` (default 25, 1 to 100; a value outside that range is `422 validation_failed`, never clamped).
* Dates and times: ISO 8601 UTC with `Z`.
* Ids: a request and a referee are addressed by their **uuid** (`uuid`); template and form ids are integers; the candidate is the `candidate_ref` (uuid of the Hub core API, `/api/v2/hub/candidates`). There is no integer candidate id.
* `Idempotency-Key` on `POST /requests` and `POST /requests/{uuid}/referees`: the same key and body within 24 hours returns the original answer with `Idempotent-Replayed: true`; the same key with a different body is `409 idempotency_conflict`.

## 2. Scopes

| Scope | Endpoints |
| --- | --- |
| `references:requests:read` | `GET /requests`, `GET /requests/{uuid}` |
| `references:requests:write` | `POST /requests`, `POST /requests/{uuid}/cancel`, `/extend`, `/referees`, `/reminders`, `POST /referees/{uuid}/reminder` |
| `references:referees:read` | `GET /referees/{uuid}`, `GET /referees/{uuid}/pdf` |
| `references:templates:read` | `GET /templates` |

`references:*` and `*` cover all. A `:write` scope does not include its `:read` scope: give both. Missing scope: `403 insufficient_scope`.

## 3. Endpoints

### 3.1 Requests

Request fields: `uuid`, `candidate_ref` (null only for a candidate Hub has not synced yet), `candidate_name`, `candidate_email`, `template` (`id`, `name` or null), `collection_mode` (`client_adds` or `candidate_provides`), `status`, `status_label`, `references_required`, `references_completed`, `is_fully_referenced`, `notes`, `expires_at`, `is_expired`, `submission_url` (for `candidate_provides`), `referees` (list of referee rows), `created_at`.

Referee row: `uuid`, `name`, `email`, `organisation`, `position`, `phone`, `relationship_to_candidate`, `status`, `status_label`, `display_status`, `sent_at`, `submitted_at`, `reminder_count`.

`GET /requests`. Query: `status`, `candidate_ref`, `collection_mode`, `is_expired`, `is_fully_referenced`, `search` (candidate name or email, referee name or email, notes), `created_from`, `created_to` (`YYYY-MM-DD`), `sort` (`created_at`, `updated_at`, `expires_at`, `status`; `-` for descending), `page`, `per_page`. A `candidate_ref` that is not one of the client's candidates is `422 validation_failed` on `candidate_ref`. `collection_mode` accepts `client_adds` or `candidate_provides` only.

`is_expired=true` returns the requests that are expired: status `expired`, or `expires_at` already past. `is_fully_referenced=true` returns the requests whose status is `completed`. `is_expired=false` returns the requests that are not (status other than `expired` and no `expires_at` in the past), and `is_fully_referenced=false` the requests whose status is not `completed`; leave a parameter out for both. Each accepts `true`, `false`, `1` or `0`; any other value is `422 validation_failed` on that parameter. `search` is matched as a part of the text, not word by word. Without `sort` the newest request comes first. The list needs `references:requests:read`; it sends no email and fires no webhook.

`GET /requests/{uuid}`: the request. Unknown or another client's uuid: `404 not_found`.

`POST /requests` (`Idempotency-Key`). Body:

| Field | Rule |
| --- | --- |
| `candidate_ref` | required, uuid of one of the client's candidates (`422` on `candidate_ref` otherwise, never 404) |
| `collection_mode` | required, `client_adds` or `candidate_provides` |
| `template_id` | optional integer, one of `GET /templates` |
| `references_required` | optional, within the client's minimum and maximum |
| `expiry_days` | optional, within the limits of the account |
| `notes` | optional text |
| `referees` | required for `client_adds`: list of `referee_name`, `referee_email`, `referee_organisation`, `referee_position` (all required) and `referee_phone`, `relationship_to_candidate` |

`201` with the request. Limits: `references_required` is at least the minimum of the client's References settings (never less than 1) and at most their maximum (standard settings 2 and 5; omitted means the minimum); `expiry_days` is 1 to 365 (omitted means the client's default, 14 days in the standard settings); `notes` at most 1000 characters; `referees` 1 to 10 items. A value outside these limits, or a `collection_mode` other than `client_adds` or `candidate_provides` (`both` is not accepted: choose one), is `422 validation_failed` on the field. `referees` is ignored for `candidate_provides`. A request the engine refuses is `422 reference_request_refused` with the reason in `message`: a `template_id` that is not available to the client, a `collection_mode` the client's settings do not allow, a `client_adds` request with no referee, or two referees with the same email address. A duplicate request for the same candidate is not refused.

Side effects of a create: for `client_adds` each referee is emailed at once and the request becomes `in_progress`; for `candidate_provides` the candidate is emailed the link to the page where they give their referees (when the candidate has no email address nothing is sent and the call still succeeds: pass the `submission_url` on yourself); and the webhook `references.reference.request.created` is queued. The `Idempotency-Key` makes a retry safe: the same key and body within 24 hours returns the first answer with `Idempotent-Replayed: true` and sends nothing again.

`POST /requests/{uuid}/cancel` returns the request. The request becomes `cancelled` (final; the API cannot reopen it) and every referee who had not completed or declined becomes `expired`, with a `reference.expired` webhook for each; referees are not emailed. A `completed` or `cancelled` request cannot be cancelled: `409 request_not_cancellable`.

`POST /requests/{uuid}/extend` (body `days`, 1 to 365) returns the request. The new expiry is `days` after the current expiry when that is still in the future, otherwise `days` after now; an expired request becomes live again and its expired referees are reopened with the same links. Nothing is emailed and no webhook is fired. A `completed` or `cancelled` request, or an imported legacy request nobody answered, cannot be extended: `409 request_not_extendable` (`409 legacy_request_unanswered` for the imported legacy request).

`POST /requests/{uuid}/referees` (`Idempotency-Key`): body `referee_name`, `referee_email`, `referee_organisation`, `referee_position` (required) and `referee_phone`, `relationship_to_candidate`; `201` with the referee row, and the referee is emailed at once. `409 request_not_open` when the request is not open (completed, cancelled, expired or past `expires_at`), `409 referee_already_added` when the email address is already used by a referee who has not declined, expired or bounced, `409 referee_limit_reached` when the request already has 10 such referees, and `409 legacy_request_unanswered` for an imported legacy request nobody answered. Adding a referee fires no webhook.

`POST /requests/{uuid}/reminders`: chases every referee who is due, `data.reminders_sent` and `data.skipped` (each waiting referee not chased, with the reason). A referee is due when they have been emailed and are not final, the request is open, they have had fewer reminders than the client's maximum and the wait has passed (standard settings: the first reminder 5 days after the request email, then every 3 days, at most 3). The call does not override these rules, so a second call straight after sends nothing. Each reminder is an email, adds 1 to `reminder_count` and queues `reference.reminder.sent`. The answer is `200` even when nothing was sent.

### 3.2 Referees

`GET /referees/{uuid}`: `uuid`, `reference_request_uuid`, `candidate_ref`, `candidate_name`, `candidate_email`, `referee` (name, email, organisation, position, phone, relationship_to_candidate), `status`, `status_label`, `display_status`, `score`, `score_breakdown`, `decline_reason`, `answers` (list of `field_code`, `label`, `value`), `has_pdf`, `sent_at`, `opened_at`, `submitted_at`, `expires_at`, `reminder_count`, `last_reminder_at`.

`score` is set only when the client uses scoring and the answers could be scored; otherwise `score` is `null` and `score_breakdown` is `[]`. `decline_reason` is the referee's free text and is set only when the status is `declined`. `answers` omits the referee's own contact details (they are in `referee`); a question the form no longer has is labelled with its `field_code`.

`GET /referees/{uuid}/pdf`: the PDF of a completed reference, as an attachment named `reference-{referee-name}-{uuid}.pdf`; a PDF that is missing from storage is built from the stored answers for that response only, nothing is saved (the call is read only). `404 pdf_not_available` for any reference that is not completed. `POST /referees/{uuid}/reminder` (scope `references:requests:write`): `data.sent: true` and `data.reminder_count`; the same rules as the batch call, and when none can be sent `409 reminder_not_sent` with the referee and reason in `message`.

### 3.3 Templates

`GET /templates`: `id`, `uuid`, `name`, `description`, `is_system`, `is_default`, `questions`, `updated_at`. The active system forms and the client's own, sorted by `name` unless `sort` (`name` or `updated_at`) is given; `is_default` marks the form a request without `template_id` uses. The questions themselves are not returned.

## 4. Webhooks

Delivery, signature headers and retries are those of Hub webhooks (`/api/v2/webhooks`). Body: `event_id`, `event_type`, `occurred_at`, `data`. Event names are prefixed `references.`, for example `references.reference.request.created`. `data` carries uuids, the `candidate_ref` and counts. It never carries the integer candidate id, the referee's name or email, or the free-text decline reason (`has_decline_reason` says whether one was given). Times (`*_at`) are ISO 8601 UTC with `Z`.

| Event | When | `data` fields |
| --- | --- | --- |
| `reference.request.created` | a request was created (API, Hub, or staff), after the emails are queued | `uuid`, `candidate_ref`, `collection_mode`, `references_required`, `expires_at` |
| `candidate.referees.submitted` | the candidate gave their referees | `reference_request_uuid`, `candidate_ref`, `referees_added` |
| `reference.submitted` | a referee submitted (`score` is a string such as `"4.25"`, or `null`) | `reference_uuid`, `reference_request_uuid`, `candidate_ref`, `score`, `submitted_at` |
| `reference.declined` | a referee declined | `reference_uuid`, `reference_request_uuid`, `candidate_ref`, `has_decline_reason` |
| `reference.expired` | a reference expired: the scheduled expiry job (where switched on), or each unfinished referee when a request is cancelled | `reference_uuid`, `reference_request_uuid`, `candidate_ref`, `expired_at` |
| `reference.reminder.sent` | a reminder went to a referee (any source) | `reference_uuid`, `reference_request_uuid`, `candidate_ref`, `reminder_number` |
| `reference.all_completed` | the submission that brings the completed count to exactly the number required; once. Can be queued before `reference.submitted` of the same submission | `reference_request_uuid`, `candidate_ref`, `references_completed`, `references_required` |

## 5. v1 to v2

| v1 | v2 |
| --- | --- |
| request `candidate` (`id`, `name`, `email`) | `candidate_ref`, `candidate_name`, `candidate_email` |
| `POST /requests` body `candidate_id` | `candidate_ref` |
| `GET /requests?candidate_id=` | `?candidate_ref=` |
| candidate of another client on create: `403 forbidden` | `422 validation_failed` on `candidate_ref` |
| `created_after`, `created_before` | `created_from`, `created_to` (`YYYY-MM-DD`) |
| none | `search` |
| bare object for one resource | `{ "data": {...} }` |
| list `meta.current_page`, `last_page` | `meta.page`, `per_page`, `total`, `last_page`; links are full URLs |
| referee `candidate` object | `candidate_ref`, `candidate_name`, `candidate_email` |
| times `+00:00` | UTC with `Z` |
| `POST /referees/{uuid}/reminder` answer `{ message, reminder_count }` | `{ "data": { "sent": true, "reminder_count" } }` |
| `GET /templates` without `meta` | standard list with `meta` and `links` |
| no `Idempotency-Key` | on `POST /requests` and `POST /requests/{uuid}/referees` |
| webhook `candidate_id`, `reference_request_id`, `referee_name`, `referee_email`, `decline_reason` | `candidate_ref`; those fields left out (`has_decline_reason`) |

## 6. Worked example

A client asks for two references for a care assistant, `candidate_ref` `9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f`, and supplies the referees itself. All calls carry `Authorization: Bearer <access_token>` and `Accept: application/json`. The key has `references:*`.

### 6.1 Choose a form (optional)

```
GET /api/v2/references/templates
```

```json
{
  "data": [
    {
      "id": 1,
      "uuid": "0b9d1a52-3c4e-4f6a-8d7b-5e2f1a0c9b34",
      "name": "HB Default",
      "description": "The standard employment reference form.",
      "is_system": true,
      "is_default": true,
      "questions": 24,
      "updated_at": "2026-03-12T10:30:00Z"
    }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 },
  "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/references/templates?page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/references/templates?page=1", "prev": null, "next": null }
}
```

### 6.2 Create the request

```
POST /api/v2/references/requests
Idempotency-Key: 6d2f1b0e-52c8-4e8a-9c41-0b7a3e5d1f90
Content-Type: application/json
```

```json
{
  "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "collection_mode": "client_adds",
  "template_id": 1,
  "references_required": 2,
  "expiry_days": 14,
  "notes": "Care assistant post, start date 2 November.",
  "referees": [
    {
      "referee_name": "Dr Helen Carter",
      "referee_email": "helen.carter@riverside-surgery.example",
      "referee_organisation": "Riverside Surgery",
      "referee_position": "Practice Manager",
      "referee_phone": "01632 960123",
      "relationship_to_candidate": "Line manager"
    },
    {
      "referee_name": "Mr David Hughes",
      "referee_email": "david.hughes@northgate-care.example",
      "referee_organisation": "Northgate Care Home",
      "referee_position": "Home Manager"
    }
  ]
}
```

`201 Created`. Both referees are emailed their private link as the call is made, and the webhook `references.reference.request.created` is queued.

```json
{
  "data": {
    "uuid": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "candidate_name": "Amelia Jones",
    "candidate_email": "amelia.jones@example.com",
    "template": { "id": 1, "name": "HB Default" },
    "collection_mode": "client_adds",
    "status": "in_progress",
    "status_label": "In progress",
    "references_required": 2,
    "references_completed": 0,
    "is_fully_referenced": false,
    "notes": "Care assistant post, start date 2 November.",
    "expires_at": "2026-11-11T09:15:00Z",
    "is_expired": false,
    "submission_url": null,
    "referees": [
      {
        "uuid": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "name": "Dr Helen Carter",
        "email": "helen.carter@riverside-surgery.example",
        "organisation": "Riverside Surgery",
        "position": "Practice Manager",
        "phone": "01632 960123",
        "relationship_to_candidate": "Line manager",
        "status": "sent",
        "status_label": "Sent",
        "display_status": "requested",
        "sent_at": "2026-10-28T09:15:00Z",
        "submitted_at": null,
        "reminder_count": 0
      },
      {
        "uuid": "b2f1c1a4-5d63-4a8e-9f0b-6a1d2c3e4f50",
        "name": "Mr David Hughes",
        "email": "david.hughes@northgate-care.example",
        "organisation": "Northgate Care Home",
        "position": "Home Manager",
        "phone": null,
        "relationship_to_candidate": null,
        "status": "sent",
        "status_label": "Sent",
        "display_status": "requested",
        "sent_at": "2026-10-28T09:15:00Z",
        "submitted_at": null,
        "reminder_count": 0
      }
    ],
    "created_at": "2026-10-28T09:15:00Z"
  }
}
```

Repeating the call with the same `Idempotency-Key` and body returns this answer again with `Idempotent-Replayed: true`; nothing is created or emailed a second time.

### 6.3 A referee submits: the webhook

On 30 October Dr Carter submits the form in her browser. Hub posts to every endpoint that picked `references.reference.submitted` (headers `X-Hub-Signature`, `X-Hub-Timestamp`, `X-Hub-Event`, `X-Hub-Event-Id`, `X-Hub-Delivery-Id`; see the webhook documentation):

```json
{
  "event_id": "4a1b7c3e-9d52-4f08-8b6a-2e5d0c7f9a13",
  "event_type": "references.reference.submitted",
  "occurred_at": "2026-10-30T14:02:12Z",
  "data": {
    "reference_uuid": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    "reference_request_uuid": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "score": null,
    "submitted_at": "2026-10-30T14:02:11Z"
  }
}
```

The event carries no answers and no name or email: it only tells you which reference to fetch. `score` is `null` for a client that does not use scoring, and otherwise a string such as `"4.25"`. When the second reference arrives `reference.all_completed` follows with `references_completed` 2 and `references_required` 2.

### 6.4 Fetch the reference and the PDF

```
GET /api/v2/references/referees/3f2504e0-4f89-41d3-9a0c-0305e82c3301
```

```json
{
  "data": {
    "uuid": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    "reference_request_uuid": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "candidate_name": "Amelia Jones",
    "candidate_email": "amelia.jones@example.com",
    "referee": {
      "name": "Dr Helen Carter",
      "email": "helen.carter@riverside-surgery.example",
      "organisation": "Riverside Surgery",
      "position": "Practice Manager",
      "phone": "01632 960123",
      "relationship_to_candidate": "Line manager"
    },
    "status": "completed",
    "status_label": "Completed",
    "display_status": "received",
    "score": null,
    "score_breakdown": [],
    "decline_reason": null,
    "answers": [
      { "field_code": "reliability", "label": "Reliability", "value": "Excellent" },
      { "field_code": "reemploy", "label": "Would you employ the candidate again?", "value": "Yes" }
    ],
    "has_pdf": true,
    "sent_at": "2026-10-28T09:15:00Z",
    "opened_at": "2026-10-29T18:40:05Z",
    "submitted_at": "2026-10-30T14:02:11Z",
    "expires_at": "2026-11-11T09:15:00Z",
    "reminder_count": 0,
    "last_reminder_at": null
  }
}
```

```
GET /api/v2/references/referees/3f2504e0-4f89-41d3-9a0c-0305e82c3301/pdf
```

`200 OK`, `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="reference-dr-helen-carter-3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf"`, and the PDF as the body. For a reference that is not completed the answer is `404`:

```json
{ "error": "pdf_not_available", "message": "No PDF is available for this reference.", "request_id": "01JBX4R9T7M2KQ8W5N3E6H1ZPA" }
```

### 6.5 Remind the referee who has not answered

On 3 November, five days after the request email, Mr Hughes is due his first reminder (standard settings):

```
POST /api/v2/references/requests/7c9e6679-7425-40de-944b-e07fc1f90ae7/reminders
```

```json
{ "data": { "reminders_sent": 1, "skipped": [] } }
```

Calling it again straight away sends nothing: `{ "data": { "reminders_sent": 0, "skipped": [ { "referee": "Mr David Hughes", "reason": "is not due a reminder until 06 Nov 2026" } ] } }`. A single referee can be chased with `POST /api/v2/references/referees/b2f1c1a4-5d63-4a8e-9f0b-6a1d2c3e4f50/reminder`, which answers `{ "data": { "sent": true, "reminder_count": 1 } }` or, when not due, `422`:

```json
{
  "error": "reminder_not_sent",
  "message": "No reminder was sent: Mr David Hughes is not due a reminder until 06 Nov 2026.",
  "request_id": "01JBX4RA2C8N5V1M7Q4D9F3GTB"
}
```

### 6.6 Cancel

The post is withdrawn, so the client cancels the request:

```
POST /api/v2/references/requests/7c9e6679-7425-40de-944b-e07fc1f90ae7/cancel
```

`200 OK` with the request: `status` is `cancelled`, `status_label` `Cancelled`. Mr Hughes, who had not answered, is now `expired` and a `references.reference.expired` webhook is queued for him with his `reference_uuid` and `expired_at`; Dr Carter's completed reference is unchanged and can still be read and downloaded. Cancelling again answers `409`:

```json
{
  "error": "request_not_cancellable",
  "message": "A cancelled request cannot be cancelled.",
  "request_id": "01JBX4RB6E1P3S8K2W7H5J9XMC"
}
```
