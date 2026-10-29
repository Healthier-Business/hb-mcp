# Occupational Health API v2: reference

Base URL: `https://hub.hbcompliance.co.uk/api/v2/occupational-health/`. Portal key `occupational-health`. Every call needs `Authorization: Bearer <access_token>` (from `POST /auth/token` with the API key) and `Accept: application/json`. The client must have Occupational Health enabled, otherwise every call is `403 portal_unavailable`. Everything is scoped to the key's client. Design notes and decisions: `../02-occupational-health-api-v2.md`.

## 1. Conventions

* A single resource is `{ "data": { ... } }`. A list is `{ "data": [ ... ], "meta": { "page", "per_page", "total", "last_page", "from", "to" }, "links": { "first", "last", "prev", "next" } }`. Short fixed lists (clearance types, forms, reports, credit packages, answers, a request's documents) are one page that holds every item.
* Errors are `{ "error": "<code>", "message": "...", "details": { "field": ["message"] } }`; `details` only on `validation_failed`. Codes: `invalid_token` 401, `key_inactive` 403, `ip_not_allowed` 403, `insufficient_scope` 403, `portal_unavailable` 403, `not_found` 404, `idempotency_conflict` 409, `request_not_online` 409, `request_closed` 409, `form_not_assigned` 409, `form_already_submitted` 409, `form_awaiting_documents` 409, `validation_failed` 422, `rate_limited` 429 (with `Retry-After`), `service_unavailable` 503 (answers could not be saved, nothing was sent; send them again). The five 409 codes other than `idempotency_conflict` belong to the answers call (section 4.8) and are explained there.
* Another client's record is always `404 not_found`, never `403`. A malformed `candidate_ref` or request id in a path is also `404 not_found`.
* Pagination: `page` (default 1) and `per_page` (default 25, 1 to 100).
* Dates and times: ISO 8601 UTC with `Z` (`2026-10-28T19:53:24Z`). Date-only fields (`next_renewal`, query dates) are `YYYY-MM-DD`.
* Money: integer pence in fields ending `_pence`, with a `currency: "GBP"` field beside it. Credits are whole numbers.
* Candidate: always the `candidate_ref` (uuid string), the same value as `candidate_ref` in the Hub core API (`/api/v2/hub/candidates`). The integer HB Portal candidate id is never returned. It is lower case; upper case is accepted in paths.
* Health data (request detail, answers, alerts, document and report downloads, and the call that submits answers) is logged in the API log without request or response bodies. Webhook bodies never carry health data either: ids, statuses and the `candidate_ref` only.
* Dates are ISO 8601 UTC with a `Z`; the exceptions are the date-only fields noted above. Credits are read only everywhere in this API and a short balance never blocks anything.

## 2. Scopes

| Scope | Endpoints |
| --- | --- |
| `occupational-health:account:read` | `GET /profile`, `GET /settings` |
| `occupational-health:catalogue:read` | `GET /clearance-types`, `GET /clearance-types/{clearance_type}/questionnaire`, `GET /request-options`, `GET /forms`, `GET /forms/{shortcode}` |
| `occupational-health:candidates:read` | `GET /candidates`, `GET /candidates/{candidate_ref}` |
| `occupational-health:candidates:write` | `POST /candidates/{candidate_ref}/reminder` |
| `occupational-health:requests:read` | `GET /requests`, `GET /requests/stats`, `GET /requests/export`, `GET /requests/{id}`, `GET /requests/{id}/answers` (health data), `GET /requests/{id}/questionnaire` |
| `occupational-health:requests:write` | `POST /requests`, `POST /requests/{id}/questionnaire/{shortcode}/answers` (submits health data on the candidate's behalf) |
| `occupational-health:documents:read` | `GET /requests/{id}/documents`, `GET /requests/{id}/documents/{file}`, `GET /requests/{id}/ftw/{ftw}` |
| `occupational-health:alerts:read` | `GET /alerts` |
| `occupational-health:alerts:write` | `POST /alerts/dismiss`, `POST /alerts/clear` |
| `occupational-health:reports:read` | `GET /reports`, `GET /reports/{type}/{format}` |
| `occupational-health:reports:write` | `POST /reports/{type}/generate` |
| `occupational-health:credits:read` | `GET /credits`, `GET /credits/transactions`, `GET /credits/packages` |

`occupational-health:*` and `*` cover all. A write scope also grants its read scope. Missing scope: `403 insufficient_scope`.

Health data follows the scopes above: reading answers, documents and reports needs the read scope of the resource, and sending answers needs `requests:write`. There is no separate health-data scope. Give a key that only needs to create requests `requests:write` and nothing for `documents` and `reports`, and keep answers-submitting keys apart from keys that merely list requests.

There is no endpoint to create a candidate (use `POST /api/v2/hub/candidates`), to top up credits (use `top_up_url`), or to change settings.

## 3. Request ids

Every request has **one id that never changes**. A request created through `POST /requests` (or the New Request page) has the integer `id` of its Hub request row; it keeps that `id` after the candidate completes the online questionnaire. Everything that names a request (list rows, detail, `POST /requests` answer, webhooks, alerts) uses the same number, and the reference is `OH-{id}`.

* `id` (integer or null): the request id.
* `submission_id` (integer or null): the id of the completed questionnaire. `null` while the request waits for the candidate, and always `null` for a paper questionnaire.
* `reference`: `OH-{id}`. For a questionnaire that has no request it is that questionnaire's own reference.
* `submission_reference`: the questionnaire's own reference (the `submission_ref` the older agency API shows), or null while it waits.

**Questionnaires with no request.** Older questionnaires, and ones sent by Healthier Business staff, have no request row. Their `id` is `null`, their `reference` is the questionnaire's own reference, and `submission_id` identifies them. They are addressed in a path as `form-{submission_id}`, for example `GET /requests/form-4821`.

**Path id.** In `/requests/{id}...`, `{id}` is a request id (`5`) or `form-{submission_id}`. Both forms give the same row for a completed request (`id` is then the request id).

**How a questionnaire is tied to a request.** Hub has no link column. A questionnaire answers the latest request for the same candidate and the same questionnaire that was submitted on or before the day the questionnaire was submitted. If a candidate had several requests open for the same questionnaire, one completed questionnaire completes all of them (as the Requests page treats it); the row shows the latest request's `id`, and older request ids return the same row.

`GET /requests?reference=OH-5` finds a request by reference at any time (waiting or completed); `reference=<questionnaire reference>` finds a questionnaire's row.

## 4. Endpoints

### 4.1 Account and catalogue

`GET /profile` (`account:read`): `id` (the client id), `name`, `notifications` (`hb`, `agency`, `both`), `document_upload`, `allows_uploads`, `ftw_routing_configured`, `credit_balance`, `credits_deducting`.

`GET /settings` (`account:read`): `notifications`, `return_email`, `copy_emails`, `document_upload`, `allow_upload`, `allow_temporary_clearance`, `chase` (`first_reminder_days`, `interval_days`, `max_emails`, `stop_after_days`, `notify_on_limit`), `emails` (list of `id`, `email`, `purpose`, `type`). Read only.

`GET /clearance-types` (`catalogue:read`): list of `id`, `name`, `needs_immunisations`, `has_scope_choice`, `has_online_form`.

`GET /request-options` (`catalogue:read`): `request_types`, `scopes`, `hq_methods`, `immunisation_methods` (each a list of `value`, `label`), `upload_kinds`, `uploads` (`extensions`, `max_kb`, `max_files`, `max_total_kb`).

`GET /forms` (`catalogue:read`): list of `shortcode`, `title`, `questions`. `GET /forms/{shortcode}`: `shortcode`, `title`, `version` (`title`, `version`, `updated`), `template` (the node tree of the form). A shortcode outside the client's form set is `404`.

### 4.2 Candidates (read only)

`GET /candidates` (`candidates:read`). Query: `search` (every word must match name, role or email), `has_forms` (`true|false`), `page`, `per_page`. Archived and locked candidates are left out. Rows: `candidate_ref`, `name`, `email`, `role`, `forms` (OH questionnaires assigned), `has_forms`. `candidate_ref` is null only for a candidate Hub has not synced yet.

`GET /candidates/{candidate_ref}` (`candidates:read`): the row plus `status` (account status) and `history`: the candidate's requests that have a questionnaire submission, newest first, as request rows (section 4.3). Requests still waiting for the candidate are found with `GET /requests?candidate_ref=`. Unknown, malformed or other-client `candidate_ref`: `404 not_found`.

`POST /candidates/{candidate_ref}/reminder` (`candidates:write`): sends the health form reminder email. Answer `{ "data": { "candidate_ref", "sent": true } }`. `422 validation_failed` on `email` when the candidate has no email address. 20 a minute per key, then `429 rate_limited`.

### 4.3 Requests

Row fields (list, detail, candidate history):

| Field | Meaning |
| --- | --- |
| `id`, `submission_id`, `reference`, `submission_reference` | see section 3 |
| `candidate_ref`, `candidate_name`, `candidate_email` | the candidate |
| `form`, `form_type` | questionnaire title and shortcode (`Paper HQ` and null for a paper questionnaire) |
| `request_type`, `request_type_label` | `new_starter` or `renewal`; the label |
| `clearance` | clearance type name |
| `submitted_at`, `completed_at`, `decided_at` | times, or null |
| `status`, `status_label` | one of `submitted`, `awaiting_candidate`, `rejected`, `full_clearance`, `temporary_clearance`, `fail` |
| `outcome_document` | `FTW Certificate`, `Fail Letter` or null |
| `documents` | number of supporting documents |
| `has_answers` | true when there is a completed questionnaire |

Staff statuses are never returned.

`GET /requests` (`requests:read`). Query: `status` (one or many), `request_type` (`new_starter`, `renewal`), `clearance` (HB Portal clearance key, for example `epp`), `form` (shortcode), `candidate_ref`, `reference`, `search`, `submitted_from`, `submitted_to`, `completed_from`, `completed_to` (`YYYY-MM-DD`), `sort` (`candidate`, `submitted`, `completed`, `status`; prefix `-` for descending; default `-submitted`), `page`, `per_page`. `candidate_ref` that is not one of the client's candidates is `422 validation_failed` on `candidate_ref`. `reference` is an exact match (`OH-5`, case does not matter, or a questionnaire reference) and can be combined with the other filters.

`GET /requests/stats` (`requests:read`): `total`, `submitted`, `awaiting_candidate`, `cleared` (full plus temporary), `rejected_or_fail`.

`GET /requests/export` (`requests:read`): CSV of the filtered table (same filters as the list, except `page`, `per_page`, `sort` and `reference`).

`GET /requests/{id}` (`requests:read`): the row plus `review_note`, `issued_at`, `next_renewal`, `renewal_state`, `candidate_status`. Logged in the OH access trail.

`GET /requests/{id}/answers` (`requests:read`): list of `{ fieldset, items: [ { label, value, image? } ] }`. Empty while the request waits. **Health data.**

`POST /requests` (`requests:write`). Body (JSON, or `multipart/form-data` when files are sent):

| Field | Rule |
| --- | --- |
| `candidate_ref` | required, uuid; must be one of the client's candidates (`422` on `candidate_ref` otherwise, not a 404) |
| `request_type` | required, `new_starter` or `renewal` |
| `clearance_type_id` | required, integer, one of `GET /clearance-types` |
| `scope` | `full` or `temporary`; required for a new starter whose clearance type needs immunisations, otherwise ignored (forced to `full`) |
| `hq_method` | required, `online` or `paper` |
| `imms_method` | `agency` or `candidate`; required for a new starter whose clearance type needs immunisations |
| `notify_candidate` | optional boolean, default `true`; `false` skips the "forms assigned" email to the candidate (online questionnaire) when you answer for them. Nothing else changes |
| `paper_hq[]` | files; required when `hq_method` is `paper` |
| `immunisation[]` | files; used for a new starter with `imms_method=agency` |
| `previous_ftw[]` | files; used for a renewal |

File types and sizes: `GET /request-options` (`uploads`). `Idempotency-Key` header: the same key and body within 24 hours returns the original answer with `Idempotent-Replayed: true`; the same key with a different body is `409 idempotency_conflict`; a repeat that the cache no longer holds returns `200` with `duplicate: true`. The requester is the user who created the API key, else the client's first user; with neither, `422` on `api_key`. A short credit balance never blocks.

Answer `201`: `id`, `reference`, `candidate_ref`, `status`, `status_label`, `awaiting_candidate`, `duplicate`, `hq_method`, `hq_form`, `request_type`, `clearance_type_id`, `clearance_type`, `scope`, `files`, `submitted_at`.

With an online questionnaire, the forms of the clearance type are assigned to the candidate (`hq_form` is the first); the candidate can complete them, or you can answer them for the candidate (section 4.8). Webhooks queued: `request.submitted`, and `request.awaiting_candidate` when the request waits for the candidate.

### 4.4 Documents (`documents:read`)

`GET /requests/{id}/documents`: list of `id`, `type` (`supporting` or `ftw`), `source` (`submission`, `candidate`, null for supporting), `filename`, `size`, `uploaded_at`, `general`, `download_url`. Empty while the request waits.

`GET /requests/{id}/documents/{file}`: streams a supporting document. `GET /requests/{id}/ftw/{ftw}?source=submission|candidate` (default `candidate`): streams a Fit to Work certificate or fail letter. `404` for anything that is not the client's own.

### 4.5 Alerts

`GET /alerts` (`alerts:read`). Query: `type` (`rejected`, `not_fit`), `page`, `per_page`. Rows: `key`, `type`, `severity` (`critical`), `status_label`, `candidate_ref`, `candidate_name`, `description` (the review note for a rejection), `clearance`, `request_id` (null for a questionnaire with no request), `submission_id`, `at`.

`POST /alerts/dismiss` (`alerts:write`): body `key` (one alert; `404` unless that alert is shown). `POST /alerts/clear`: dismisses all shown. Both answer `{ "data": { "dismissed": n } }`. A dismissal holds until the request changes status.

### 4.6 Reports

`GET /reports` (`reports:read`): the three reports `all_requests` (xlsx), `activity` (pdf), `expiring` (xlsx): `type`, `title`, `subtitle`, `format`, `status` (`idle`, `processing`, `complete`), `percent`, `count`, `generated_at`.

`POST /reports/{type}/generate` (`reports:write`): queues the report, `202 { "data": { "type", "status": "processing" } }`; 10 a minute per key. `GET /reports/{type}/{format}` (`reports:read`): downloads `xlsx` or `pdf` (the report's own format) or `csv` (every report). `404` "Generate the report first." before a run.

### 4.7 Credits (`credits:read`, read only)

`GET /credits`: `balance`, `used_this_month`, `deducting`, `credits_per_new_starter` (credits), `price_per_credit_pence`, `currency` (`GBP`), `top_up_url`.

`GET /credits/transactions`. Query: `type` (`all`, `credit`, `debit`), `created_from`, `created_to`, `page`, `per_page`. Rows: `id`, `created_at`, `description`, `note`, `amount` (credits, always positive), `is_credit`, `candidate_ref`, `candidate_name`.

`GET /credits/packages`: `credits`, `price_pence`, `vat_pence` (0), `total_pence`, `per_credit_pence`, `currency`.

### 4.8 Questionnaires: answering for a candidate

A request created with an online questionnaire assigns the **forms of its clearance type** to the candidate. You never choose a form: the clearance type decides it (a list set for your account wins over the standard list of the type, which wins over the single questionnaire the type always had). The candidate is emailed to complete the forms, or you can answer them for the candidate with the calls below. Either way the candidate's questionnaire is the same record, the request is released to Healthier Business in the same way and the same webhook is sent.

`GET /clearance-types/{clearance_type}/questionnaire` (`catalogue:read`): a preview before any request exists. `{clearance_type}` is an `id` from `GET /clearance-types` (a type your account cannot use is `404 not_found`). Answer `data`: `clearance_type_id`, `clearance_type`, `source` (`override`, `default` or `legacy`: where the list of forms comes from), `forms`, `dropped_forms` (shortcodes the type lists that your account does not have; Healthier Business arrange those by email), `documents` and `request` (null here). A type with no online questionnaire has `forms: []`.

`GET /requests/{id}/questionnaire` (`requests:read`): the same answer for one request, with `request` (`id`, `reference`, `candidate_ref`, `status`, `status_label`, `accepts_answers`, `blocked_by`) and, on each form, where it stands for the candidate. `{id}` is a request id (`form-{submission_id}` is `404`: an older questionnaire has no request to answer). `accepts_answers` is false when `blocked_by` has a `code`: `request_not_online` (a paper questionnaire, or Hub has no form for the clearance type) or `request_closed` (an outcome is already recorded).

Each form of the answer has `shortcode`, `title`, `documents_required` and `fieldsets`: the headings of the questionnaire in order, each with `questions`. On a request each form also has `state` (`due`, `saved`, `submitted`, `resubmit`, `more_info`), `can_submit`, `submission_id`, `submission_reference`, `submitted_at` and `submitted_by` (`candidate` or `client_api`). `state` is the candidate's own: `due` not sent, `saved` the candidate saved it and has to upload documents themselves (it cannot be sent through the API), `submitted` sent, `resubmit` rejected and to be sent again, `more_info` the reviewer asked for more. A form is sendable in every state except `saved` and `submitted`. A form the candidate sent in the last 90 days counts for every request that names that form.

A question has:

| Field | Meaning |
| --- | --- |
| `key` | the name you answer it under, in `answers`, `required_when` and `show_when` |
| `label` | the question as the candidate reads it |
| `type` | `text`, `textarea`, `email`, `tel`, `url`, `number`, `currency`, `scale`, `time`, `date`, `select`, `radio`, `yes-no`, `yes-no-na`, `rating`, `checkbox`, `declaration`, `checkbox-list`, `date-range`, `rating-grid`, `group` or `signature` |
| `required` | must be answered whenever it is shown (a hidden question is never required) |
| `required_when` | for a question required only in some cases, the conditions that make it required (all must hold); then `required` is false |
| `options` | the accepted answers of a choice: `value` (what you send) and `label` |
| `max_length`, `rules`, `notes` | the longest answer, the form's validation rules (information only; they are applied for you) and help text |
| `show_when` | null when the question always shows; otherwise `mode` (`show_when` or `hide_when`), `logic` (`all` or `any`) and `conditions` of `question`, `operator` (`equals`, `not_equals`, `contains`, `not_contains`, `greater_than`, `less_than`, `is_empty`, `is_not_empty`) and `value`. A hidden question is not required and its answer is thrown away |
| `config` | for a structured question: `grid_rows`, `grid_columns`, `group_columns`, `min_rows`, `max_rows`, `min`, `max`, `allow_other`; otherwise null |
| `answer_format` | what to send for this kind of question, in words |

The shape of an answer by `type`: a text, `select`, `radio`, `yes-no` (`yes`, `no`), `yes-no-na` (`yes`, `no`, `na`) and `rating` (1 to 5) is a string (or a number); `number`, `currency`, `scale`, `date` (`YYYY-MM-DD` or `DD/MM/YYYY`), `time` (`HH:MM`), `email`, `tel` and `url` are strings in that format; `checkbox` and `declaration` are `true` to tick and `false` or empty to leave clear (a declaration that is required must be ticked); `checkbox-list` is a list of option values; `date-range` is `[from, to]`; `rating-grid` is an object of row id to the chosen column; `group` is a list of rows, each an object of column id to value; `signature` is a PNG data URL (`data:image/png;base64,...`). The date of birth of a legacy form is three questions, `dob_day`, `dob_month` and `dob_year`.

`POST /requests/{id}/questionnaire/{shortcode}/answers` (`requests:write`, `Idempotency-Key`). Body, `multipart/form-data` (or JSON `{ "answers": { ... } }` when you send no files):

| Field | Rule |
| --- | --- |
| `answers` | required object of question `key` to answer (send `{}` when nothing is answered and everything is optional). With multipart: `answers[key]=value`, a list as `answers[key][]=value` |
| `documents[]` | files, up to 20: JPG, PNG or PDF, up to 8 MB each. At least one when the form says `documents_required`; not accepted when the account does not allow uploads |

`{shortcode}` must be one of the forms of the request (`404 not_found` otherwise). Hub validates the answers with the same checks as the candidate's own form: required questions, types and lengths, the options of a choice, date and phone formats, structured answers and conditional questions. Every problem comes back together as `422 validation_failed` with `details` keyed `answers.{key}` (for example `answers.is_epp`) and `documents`; an answer to a key that is not a question of the form is `422` too, so a mistyped key is never silently lost. Nothing is saved on a `422`. No defaults are filled in: send every question that is shown.

The same conflicts the candidate flow has, each with its own `409` code: `request_not_online`, `request_closed`, `form_not_assigned` (the form is not assigned to the candidate), `form_already_submitted` (this form was already sent within the last 90 days, by the candidate or by an earlier call) and `form_awaiting_documents` (the candidate saved it and has to upload documents). A form that needs documents must come with them in the same call: there is no saved-draft step, so a form is sent whole or not at all. Because of that there is no `PUT`: an answer that is accepted is final.

Answer `201`: `request_id`, `reference`, `candidate_ref`, `form`, `submission_id`, `submission_reference`, `status` and `status_label` (the request's client status after the call), `forms_remaining` (shortcodes still to send), `request_complete`, `documents` (files stored), `submitted_by` (`client_api`) and `submitted_at`. It holds no answers: read them with `GET /requests/{id}/answers`.

What the call does, and why the state is the same as the candidate's: the candidate's questionnaire is saved with its reference and status `proc`; the candidate's last form is updated; when credit deduction is on, a new starter's first submission costs `credits_per_new_starter` credits (a short balance never blocks, and renewals are free); the Fit to Work request is emailed to Healthier Business with its files once the request's **first** form is in (the candidate is emailed nothing by this call); `occupational-health.request.questionnaire_completed` is queued with `submitted_by` `client_api`; and the account's legacy form callback, if it has one, is queued as for any submission. A request with several forms takes one call per form, in any order; its status stays `awaiting_candidate` until its first form is in.

Who sent it is recorded. Hub's own table `oh_api_answer_submissions` stores, per questionnaire, the request, the API key, the key's owner and the `Idempotency-Key`; the activity trail notes "by the client through the API on the candidate's behalf"; and `submitted_by` is `client_api` in the answer of this call, in `GET /requests/{id}/questionnaire` and in the webhook. (`via_impersonation`, which exists only on login events, was not reusable.)

The request and response bodies of this call are never written to the API log, and no answer is in any webhook.

## 5. Worked example: create, answer for the candidate, receive the webhook

All calls carry `Authorization: Bearer <access_token>` and `Accept: application/json`. The candidate already exists in the Hub core API. The key has `occupational-health:*`.

**1. Preview the questionnaire** of the EPP clearance type (`id` 3).

```
GET /api/v2/occupational-health/clearance-types/3/questionnaire
```

The answer lists `forms[0]` `clinical_occupational_health`, its `fieldsets` and, for each question, its `key`, `type`, `required` and `answer_format`.

**2. Create the request** with an online questionnaire.

```
POST /api/v2/occupational-health/requests
Idempotency-Key: 6f2f3b9e-0c1d-4c1e-9d55-2a1f7a5e8b01
Content-Type: application/json
```

```json
{ "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", "request_type": "new_starter", "clearance_type_id": 3, "scope": "full", "hq_method": "online", "imms_method": "agency", "notify_candidate": false }
```

`notify_candidate: false` stops Hub emailing the candidate to complete the form, because the next step answers it for them. Leave it out (default `true`) when the candidate will complete the questionnaire themselves.

`201`: `id` 5, `reference` `OH-5`, `status` `awaiting_candidate`, `hq_form` `clinical_occupational_health`. The webhooks `request.submitted` and `request.awaiting_candidate` are queued.

**3. Read what to send** for the request.

```
GET /api/v2/occupational-health/requests/5/questionnaire
```

`data.request.accepts_answers` is `true` and `data.forms[0].state` is `due` and `can_submit` is `true`.

**4. Submit the answers** for the candidate.

```
POST /api/v2/occupational-health/requests/5/questionnaire/clinical_occupational_health/answers
Idempotency-Key: 0b8d1c5a-77a3-4d2a-b6f5-3c9e5d0a1f22
Content-Type: application/json
```

```json
{ "answers": { "first_name": "Ann", "last_name": "Lee", "dob_day": "14", "dob_month": "3", "dob_year": "1990", "is_epp": "yes", "epp_details": "Theatre nurse, 4 years.", "bbv": "no", "consent": true } }
```

`201 Created`:

```json
{
  "data": {
    "request_id": 5,
    "reference": "OH-5",
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "form": "clinical_occupational_health",
    "submission_id": 4821,
    "submission_reference": "202610281953004821",
    "status": "submitted",
    "status_label": "Submitted To Healthier Business",
    "forms_remaining": [],
    "request_complete": true,
    "documents": 0,
    "submitted_by": "client_api",
    "submitted_at": "2026-10-28T19:53:24Z"
  }
}
```

If an answer is invalid, nothing is saved and every problem comes back together:

```json
{
  "error": "validation_failed",
  "message": "Required field",
  "details": { "answers.epp_details": ["Required field"], "answers.dob_year": ["Must be exactly 4 characters"] },
  "request_id": "01M6..."
}
```

Sending it again after the fix with the same `Idempotency-Key` is safe: only a successful answer is remembered. Sending the same form a second time is `409 form_already_submitted`.

**5. Receive the webhook.** Hub sends `occupational-health.request.questionnaire_completed` (verify `X-Hub-Signature` first):

```json
{
  "event_id": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "event_type": "occupational-health.request.questionnaire_completed",
  "occurred_at": "2026-10-28T19:53:25Z",
  "data": { "request_id": 5, "submission_id": 4821, "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", "status": "submitted", "reference": "OH-5", "submission_reference": "202610281953004821", "form": "clinical_occupational_health", "submitted_by": "client_api" }
}
```

**6. Read the answers back** with `GET /api/v2/occupational-health/requests/5/answers` (health data), and wait for the outcome events (`request.full_clearance` and so on, then `document.available`).

## 6. Webhooks

Delivery, signature headers and retries are those of Hub webhooks (`/api/v2/webhooks`). Body: `event_id`, `event_type`, `occurred_at`, `data`. Ids, `candidate_ref` and statuses only; never answers, review notes or document contents. Event names are prefixed `occupational-health.`.

Common `data` fields for request events: `request_id` (integer or null, section 3), `submission_id` (integer or null), `candidate_ref`, `status` (client status).

| Event | When | Extra `data` fields |
| --- | --- | --- |
| `request.submitted` | a request was created (API or New Request page) | `reference` (`OH-{id}`), `request_type` |
| `request.awaiting_candidate` | created with an online questionnaire to complete, or a reviewer asked for more information | created: `reference`, `awaiting` (`questionnaire`), `form`; reviewer: `reference`, `submission_reference`, `form`, `has_review_note` |
| `request.questionnaire_completed` | a questionnaire was completed: by the candidate, or by you through `POST /requests/{id}/questionnaire/{shortcode}/answers` | `reference`, `submission_reference`, `form`, `submitted_by` (`candidate` or `client_api`); `request_id` is the id the request had while waiting. One event per form |
| `request.rejected` | rejected | `reference`, `submission_reference`, `form`, `has_review_note` |
| `request.full_clearance` | full or conditional clearance recorded | as rejected, plus `next_renewal` (date) for a questionnaire |
| `request.temporary_clearance` | temporary clearance recorded | as rejected |
| `request.fail` | not fit recorded | as rejected |
| `document.available` | a current FTW certificate or fail letter was recorded | `request_id` (null for a candidate's standing document), `submission_id`, `candidate_ref`, `document_id`, `source` (`submission` or `candidate`), `kind` (`ftw_certificate`, `fail_letter`) |
| `renewal.due` | a renewal reminder email was sent | `candidate_ref`, `due_at` (date) |
| `webhook.test` | the test button | `message` |

Example (`request.questionnaire_completed`):

```json
{
  "event_id": "evt_...",
  "event_type": "occupational-health.request.questionnaire_completed",
  "occurred_at": "2026-10-28T19:53:24Z",
  "data": { "request_id": 5, "submission_id": 4821, "candidate_ref": "9f1c...", "status": "submitted", "reference": "OH-5", "submission_reference": "202610281953004821", "form": "clinical_occupational_health", "submitted_by": "candidate" }
}
```

`has_review_note` is a boolean; read the note itself with `GET /requests/{id}`. `credit.low` is not offered.
