# Registration Monitoring API v2: reference

Base URL: `https://hub.hbcompliance.co.uk/api/v2/registration-monitoring/`. Portal key `registration-monitoring`. Every call needs `Authorization: Bearer <access_token>` (from `POST /auth/token` with the API key) and `Accept: application/json`. The client must have a monitoring account, otherwise every call is `403 portal_unavailable`. Everything is scoped to the key's client. A key made for this portal does not work on `/api/v2/dbs-rtw/` and the other way round.

The records are **monitored workers** (a professional registration: regulator and registration number), not Hub candidates. A worker is created by this API, the Hub pages or an import; it is **not** created from a Hub candidate, and this API does not link a worker to one. A worker that was linked to a Hub candidate elsewhere (Hub staff tools) shows that candidate's `candidate_ref`. DBS & Right To Work shares the code of alerts, imports, billing, team, monitoring settings and verification: see `dbs-rtw.md` for what differs.

## Lifecycle: from a worker to an alert

1. **Create a worker** with `POST /workers` (a regulator and a registration number, with the worker's consent). Nothing is checked yet and nothing is charged by the call; the worker is active and waits for its first check.
2. **A check runs** at the next scheduled monitoring run, or when you ask for one with `POST /workers/{id}/verify` (or `POST /verify/batch`). The call answers `202` with a job id; poll `GET /verify/jobs/{job}`. The check reads the regulator's register, stores a check row (`GET /workers/{id}/verification`), captures evidence files (`GET /workers/{id}/evidence`) and updates the worker's `status`, `expiry_date` and `restrictions`.
3. **Webhooks and alerts** follow the result. The first result sends `registration-monitoring.worker.initial_verification`; every later change of status sends `registration-monitoring.worker.status_changed`. A status change, the first result and a regulator warning or condition appearing or clearing each raise an alert (`GET /alerts`), which is also emailed to the account's notification address and stays open until you acknowledge it (`POST /alerts/{id}/acknowledge`).
4. **Re-check** on the schedule you set with `PATCH /workers/{id}/monitoring-settings` (`check_frequency` from weekly to yearly). A check that fails (the regulator's site was unavailable, for example) does not change the status and is retried later.
5. **Billing** is a monthly subscription for the account, not a charge per check: every active worker counts towards it (`GET /billing/usage`, `GET /billing/bills`). Checks stop when the free trial (one month from the first worker) is over and Direct Debit is not set up; a manual check is then refused with `422 verification_refused`.

Privacy: a worker is not a Hub candidate and is not created from one. The only link is the read only `candidate_ref`, filled when Hub staff linked the worker. Webhooks carry the worker id, the regulator, the registration number and statuses, never the worker's name, email or date of birth. Alerts, evidence files and raw data can contain personal data: store them with the care you give the worker's record.

## 1. Conventions

* A single resource is `{ "data": { ... } }`. A list is `{ "data": [ ... ], "meta": { "page", "per_page", "total", "last_page", "from", "to" }, "links": { "first", "last", "prev", "next" } }`.
* Errors are `{ "error": "<code>", "message": "...", "details": { "field": ["message"] } }`; `details` only on `validation_failed` (and on `verification_refused` for a batch, as `details.refused`). Codes: `invalid_token` 401, `insufficient_scope` 403, `portal_unavailable` 403, `not_found` 404, `idempotency_conflict` 409, `validation_failed` 422, `workers_not_found` 422, `verification_refused` 422, `no_active_workers` 422, `too_many_workers` 422, `invalid_track` 422, `track_required` 422, `rate_limited` 429.
* Another client's record is always `404 not_found`, never `403`.
* Pagination: `page` (default 1) and `per_page` (default 25, 1 to 100; more is `422 validation_failed`) on every list.
* Dates and times: ISO 8601 UTC with `Z` (`2026-10-28T19:53:24Z`). Date-only fields (`date_of_birth`, `expiry_date`, `monitoring_start_date`) are `YYYY-MM-DD`.
* Money: integer pence in fields ending `_pence`, with a `currency: "GBP"` field beside it.
* Ids are integers (worker, check, alert, import, job, evidence file, bill). `candidate_ref` is the uuid of the Hub core API (`/api/v2/hub/candidates`).
* `Idempotency-Key` on `POST /workers`, `POST /workers/{id}/verify`, `POST /verify/batch` and `POST /worker-imports`: the same key and body within 24 hours returns the original answer with `Idempotent-Replayed: true`; the same key with a different body is `409 idempotency_conflict`.

## 2. Scopes

| Scope | Endpoints |
| --- | --- |
| `registration-monitoring:workers:read` | `GET /workers`, `GET /workers/{id}` |
| `registration-monitoring:workers:write` | `POST /workers`, `PUT` or `PATCH /workers/{id}`, `DELETE /workers/{id}`, `PATCH /workers/{id}/monitoring-settings`, `POST /workers/monitoring-settings/bulk` |
| `registration-monitoring:evidence:read` | `GET /workers/{id}/evidence`, `GET /evidence/{file}`, `GET /evidence/{file}/download`, `GET /registration-checks/{check}/raw-data` |
| `registration-monitoring:verification:read` | `GET /workers/{id}/verification`, `GET /verify/jobs/{job}` |
| `registration-monitoring:verification:write` | `POST /workers/{id}/verify`, `POST /verify/batch` |
| `registration-monitoring:alerts:read` | `GET /alerts`, `GET /alerts/{id}` |
| `registration-monitoring:alerts:write` | `POST /alerts/acknowledge`, `POST /alerts/{id}/acknowledge` |
| `registration-monitoring:imports:read` | `GET /worker-imports`, `GET /worker-imports/template`, `GET /worker-imports/{id}` |
| `registration-monitoring:imports:write` | `POST /worker-imports/preview`, `POST /worker-imports` |
| `registration-monitoring:team:read` | `GET /team/roles` |
| `registration-monitoring:billing:read` | `GET /billing/usage`, `GET /billing/bills`, `GET /billing/bills/{id}/invoice` |

`registration-monitoring:*` and `*` cover all. A `:write` scope does not include its `:read` scope: give both. Missing scope: `403 insufficient_scope`.

## 3. Endpoints

### 3.1 Workers

Worker fields: `id`, `candidate_ref` (null unless linked to a Hub candidate), `first_name`, `last_name`, `email`, `phone`, `date_of_birth`, `profession`, `regulator`, `registration_number`, `status`, `status_label`, `restrictions`, `has_warning`, `has_condition`, `expiry_date`, `check_frequency`, `monitoring_start_date`, `is_active`, `consent_given`, `compliance_officer_name`, `notes`, `last_checked_at`, `next_check_due_at`.

`GET /workers`. Query: `search` (name, registration number, email), `candidate_ref`, `regulator`, `status` (a status, or `not_checked`), `is_active`, `check_frequency`, `page`, `per_page`. A `candidate_ref` that is not one of the client's candidates is `422 validation_failed` on `candidate_ref`.

`GET /workers/{id}`: the worker plus `recent_checks` (last 10: `id`, `checked_at`, `status`, `status_label`, `status_changed`, `previous_status`, `expiry_date`, `method`, `result`) and `recent_alerts` (last 10: `id`, `type`, `severity`, `title`, `acknowledged`, `created_at`).

`POST /workers` (`Idempotency-Key`): `first_name`, `last_name`, `email`, `regulator`, `registration_number`, `profession`, `consent_given` (must be true), `date_of_birth` (required for an NMC registration), and the optional monitoring fields of the Hub form. The registration must not already be monitored (`422` on `registration_number`). `201` with the worker. `PUT` or `PATCH /workers/{id}` changes who the worker is (`first_name`, `last_name`, `email`, `phone`, `date_of_birth`, `profession`, `compliance_officer_name`, `notes`, `regulator`, `registration_number`); `DELETE /workers/{id}` answers `{ "data": { "id", "deleted": true } }`.

`PATCH /workers/{id}/monitoring-settings`: `check_frequency`, `monitoring_start_date`, `is_active` (at least one). Answer: `id`, `is_active`, `monitoring_start_date`, `registration` (`check_frequency`, `next_check_due_at`). `POST /workers/monitoring-settings/bulk`: the same fields plus `worker_ids` (1 to 500, all the client's, else `422 workers_not_found`); answer `{ "data": { "updated_count" } }`.

### 3.2 Evidence

`GET /workers/{id}/evidence` (paged; `captured_from`, `captured_to`, `sort` by `captured_at`, `id` or `file_size`): list of `id`, `registration_check_id`, `worker_id`, `type` (`screenshot`, `html_snapshot`, `sanction_pdf` or `determination_pdf`), `file_name`, `mime_type`, `file_size`, `captured_at`, `download_url`. `GET /evidence/{file}`: one row. `GET /evidence/{file}/download`: the file, sent inline with `Cache-Control: private, no-store`; a saved HTML page is sent as `text/plain`. `GET /registration-checks/{check}/raw-data`: `{ "data": { "format": "json", "content": ... } }`, what the regulator returned.

### 3.3 Verification

`POST /workers/{id}/verify` (`Idempotency-Key`): queues a re-check, `202` with `job_id`, `track` (`registration`), `status`. Refused by the portal rules (manual re-checks off, worker inactive, limits): `422 verification_refused`. `POST /verify/batch` (`Idempotency-Key`): body `worker_ids` (up to 200; omitted means every active worker); `202` with `jobs` (`worker_id`, `track`, `job_id`) and `refused`; nothing queued is `422 verification_refused` with `details.refused`. `GET /workers/{id}/verification`: the check history, newest first (the `recent_checks` fields). `GET /verify/jobs/{job}`: `job_id`, `track`, `regulator`, `status`, `total_workers`, `processed_count`, `success_count`, `failed_count`, `status_changes_found`, `started_at`, `completed_at`, `error_message`.

### 3.4 Alerts

`GET /alerts`. Query: `acknowledged`, `severity` (`critical`, `high`, `medium`, `low`), `type`, `worker_id`, `page`, `per_page`. Row: `id`, `type`, `type_label`, `severity`, `title`, `description`, `previous_status`, `new_status`, `acknowledged`, `acknowledged_at`, `created_at`, `registration_check_id`, `worker` (`id`, `name`, `regulator`, `registration_number`). `GET /alerts/{id}`: one row. `POST /alerts/{id}/acknowledge`: the row. `POST /alerts/acknowledge`: body `ids` (up to 500), or `type`, or nothing for every open alert of the portal; answer `{ "data": { "acknowledged_count" } }`.

### 3.5 Imports

`POST /worker-imports/preview` (multipart `file` CSV, optional `column_mapping`, `check_frequency`, `monitoring_start_date`, `consent_given`, `is_active`): a dry run, nothing stored: `headers`, `expected_fields`, `suggested_mapping`, `sample_rows` (five), `total_rows`, `rows_checked` (at most 1000), `valid_count`, `invalid_count`, `truncated`, `errors` (at most 200). The import never guesses a column mapping: send the `suggested_mapping` of a preview as `column_mapping` to use it. A row's `consent_given` defaults to false for an import, unlike `POST /workers`, which requires consent. `POST /worker-imports` (`Idempotency-Key`): the same body, starts the import, `202` with the import row. `GET /worker-imports` and `GET /worker-imports/{id}`: `id`, `status` (`pending`, `processing`, `completed`, `failed`), `file_name`, `total_rows`, `imported_count`, `failed_count`, `progress`, `errors` (`line` and `message`, at most 1000), `processed_at`. Both monitoring portals list all of the account's imports. `GET /worker-imports/template`: `columns`.

### 3.6 Team and billing

`GET /team/roles`: `{ "data": { "roles": [ { "name", "permissions" } ], "permissions": [ { "key", "label", "permissions": [ { "name", "label" } ] } ] } }`.

`GET /billing/usage`: `currency`, `trial`, `billing_type`, `billing_types`, `allow_billing`, `direct_debit`, `estimate` (`month`, `active_workers`, `vat_rate_percent`, `selected`, and `options`, an **object** with the keys `per_candidate` and `fixed_monthly`, each with `billing_type`, `label`, `tier_label`, `base_amount_pence`, `vat_amount_pence`, `total_amount_pence`, `currency`), `tiers` (`per_candidate` and `fixed_monthly`, each a list of `label`, `price_pence`, `currency`). The Direct Debit set-up link is never returned. `GET /billing/bills`: `id`, `bill_number`, `period`, `active_workers`, `billing_type`, `tier_label`, `base_amount_pence`, `adjustments_total_pence`, `vat_amount_pence`, `total_amount_pence`, `currency`, `status`, `status_label`, `status_tone`, `due_at`, `paid_at`, `generated_at` (the last three are dates). `GET /billing/bills/{id}/invoice`: the PDF.

## 4. Webhooks

Delivery, signature headers and retries are those of Hub webhooks (`/api/v2/webhooks`). Body: `event_id`, `event_type`, `occurred_at`, `data`. Event names are prefixed `registration-monitoring.`. Payloads keep the worker id and carry no name or `candidate_ref`. Times (`*_at`) are ISO 8601 UTC with `Z`. The Hub endpoint test (`POST /api/v2/webhooks/{id}/test`) is described with the account webhooks; it is not a portal event.

| Event | When | `data` fields |
| --- | --- | --- |
| `worker.status_changed` | a completed check found a different status from the one the worker had (not for the first result, and never for a failed check) | `worker_id`, `registration_check_id`, `regulator` (lower case key), `registration_number`, `previous_status`, `new_status`, `checked_at` |
| `worker.initial_verification` | the first check that returned a status for a worker completed | `worker_id`, `registration_check_id`, `regulator`, `registration_number`, `status`, `checked_at` |

Both are sent for checks you ask for through the API and for scheduled checks. The registration number identifies a person on the regulator's register, so treat the payload as personal data. The old v1 endpoints receive different bodies; only the Hub (v2) body is described here.

## 5. v1 to v2

| v1 | v2 |
| --- | --- |
| bare object for one resource | `{ "data": {...} }` |
| list `meta.current_page`, `last_page`; defaults 50 (workers, alerts, imports), 24 (bills), 20 (history) | `meta.page`, `per_page`, `total`, `last_page`; default 25 |
| `GET /workers?q=` | `?search=` |
| worker has no candidate field | `candidate_ref` (read only, null unless linked) and `?candidate_ref=` filter |
| times `+00:00` | UTC with `Z` |
| `DELETE /workers/{id}` answer `{ message }` | `{ "data": { "id", "deleted": true } }` |
| bulk monitoring answer `{ message, updated_count }` | `{ "data": { "updated_count" } }` |
| bulk acknowledge answer `{ message, acknowledged_count }` | `{ "data": { "acknowledged_count" } }` |
| `POST /workers/{id}/verify` answer `{ message, job_id, track, status }` | `{ "data": { "job_id", "track", "status" } }`; batch `{ "data": { "jobs", "refused" } }` |
| batch refusal `{ error, message, refused }` | `{ error, message, details: { refused } }` |
| `abort(422)` answers `{ message }` | `{ error, message }` |
| raw data `{ format, data }` | `{ "data": { "format", "content" } }` |
| `GET /team/roles` `{ data: roles, permissions }` | `{ "data": { "roles", "permissions" } }` |
| billing money in pence without a currency | the same pence fields plus `currency: "GBP"` |
| no `Idempotency-Key` | on worker, verify, batch and import POSTs |
| webhook times `+00:00` | UTC with `Z` |

## 6. Worked example: from a new worker to a billed month

Base URL `https://hub.hbcompliance.co.uk/api/v2/registration-monitoring`. Every call carries `Authorization: Bearer <access_token>` and `Accept: application/json`. The key has the scopes `registration-monitoring:workers:write`, `:workers:read`, `:verification:write`, `:verification:read`, `:alerts:read`, `:alerts:write`, `:evidence:read` and `:billing:read`.

### 6.1 Create a worker

```
POST /workers
Idempotency-Key: 3b0f7c4e-6c1d-4c58-9b0e-2f8a1d5e7a10
Content-Type: application/json
```

```json
{
  "first_name": "Jane",
  "last_name": "Doe",
  "email": "jane.doe@example.com",
  "regulator": "nmc",
  "registration_number": "12A3456E",
  "date_of_birth": "1988-04-17",
  "profession": "Registered Nurse",
  "check_frequency": "monthly",
  "consent_given": true
}
```

`201 Created`. The worker is active but has not been checked: `status` and the check dates are null.

```json
{
  "data": {
    "id": 41,
    "candidate_ref": null,
    "first_name": "Jane",
    "last_name": "Doe",
    "email": "jane.doe@example.com",
    "phone": null,
    "date_of_birth": "1988-04-17",
    "profession": "Registered Nurse",
    "regulator": "nmc",
    "registration_number": "12A3456E",
    "status": null,
    "status_label": "Awaiting Initial Check",
    "restrictions": null,
    "has_warning": false,
    "has_condition": false,
    "expiry_date": null,
    "check_frequency": "monthly",
    "monitoring_start_date": "2026-10-28",
    "is_active": true,
    "consent_given": true,
    "compliance_officer_name": null,
    "notes": null,
    "last_checked_at": null,
    "next_check_due_at": null
  }
}
```

Sending the same request again with the same `Idempotency-Key` returns this answer with `Idempotent-Replayed: true`. Without the key, a repeat is `422` on `registration_number` because the registration is already monitored:

```json
{
  "error": "validation_failed",
  "message": "This registration is already being monitored.",
  "details": { "registration_number": ["This registration is already being monitored."] },
  "request_id": "01JBX4R9T7M2KQ8W5N3E6H1ZPA"
}
```

### 6.2 Ask for the first check and follow it

```
POST /workers/41/verify
Idempotency-Key: 8d2a91f0-35c7-4a6e-a1d4-7c0b5e9f3a21
```

`202 Accepted`:

```json
{ "data": { "job_id": 512, "track": "registration", "status": "pending" } }
```

```
GET /verify/jobs/512
```

```json
{
  "data": {
    "job_id": 512,
    "track": "registration",
    "regulator": "nmc",
    "status": "completed",
    "total_workers": 1,
    "processed_count": 1,
    "success_count": 1,
    "failed_count": 0,
    "status_changes_found": 0,
    "started_at": "2026-10-28T09:12:40Z",
    "completed_at": "2026-10-28T09:12:51Z",
    "error_message": null
  }
}
```

`status_changes_found` is 0 because a first result is not a change. If the account may not run checks the first call is refused instead:

```json
{
  "error": "verification_refused",
  "message": "Manual re-check is not enabled for this account.",
  "request_id": "01JBX4SC3N8Q1D7V0M5R2YHE4K"
}
```

### 6.3 The webhook

Your endpoint (registered with `POST /api/v2/webhooks`, event `registration-monitoring.worker.initial_verification` selected) receives the first result. Headers: `X-Hub-Event: registration-monitoring.worker.initial_verification`, `X-Hub-Event-Id`, `X-Hub-Delivery-Id`, `X-Hub-Timestamp`, `X-Hub-Signature`. Body:

```json
{
  "event_id": "7e0a3c52-6d4f-4b8a-9f21-5a1c8e2d0b43",
  "event_type": "registration-monitoring.worker.initial_verification",
  "occurred_at": "2026-10-28T09:12:50Z",
  "data": {
    "worker_id": 41,
    "registration_check_id": 88,
    "regulator": "nmc",
    "registration_number": "12A3456E",
    "status": "active",
    "checked_at": "2026-10-28T09:12:44Z"
  }
}
```

The first result of an active registration also raised an alert (`Initial Verification Completed`, severity `low`). A month later the scheduled check finds the registration has lapsed and your endpoint receives:

```json
{
  "event_id": "c41b2d90-1a7e-4f36-8d05-9b3e6a7f1c28",
  "event_type": "registration-monitoring.worker.status_changed",
  "occurred_at": "2026-11-28T09:15:04Z",
  "data": {
    "worker_id": 41,
    "registration_check_id": 131,
    "regulator": "nmc",
    "registration_number": "12A3456E",
    "previous_status": "active",
    "new_status": "lapsed",
    "checked_at": "2026-11-28T09:15:02Z"
  }
}
```

### 6.4 Read and acknowledge the alert

```
GET /alerts?acknowledged=false&worker_id=41
```

```json
{
  "data": [
    {
      "id": 9,
      "type": "registration_expired",
      "type_label": "Registration expired",
      "severity": "high",
      "title": "Jane Doe - Registration Lapsed",
      "description": "NMC registration 12A3456E status changed from active to lapsed.",
      "previous_status": "active",
      "new_status": "lapsed",
      "acknowledged": false,
      "acknowledged_at": null,
      "created_at": "2026-11-28T09:15:03Z",
      "registration_check_id": 131,
      "worker": { "id": 41, "name": "Jane Doe", "regulator": "NMC", "registration_number": "12A3456E" }
    }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 },
  "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/registration-monitoring/alerts?acknowledged=false&worker_id=41&page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/registration-monitoring/alerts?acknowledged=false&worker_id=41&page=1", "prev": null, "next": null }
}
```

```
POST /alerts/9/acknowledge
```

`200` with the alert, now `"acknowledged": true` and `"acknowledged_at": "2026-11-28T10:02:11Z"`.

### 6.5 Download the evidence

```
GET /workers/41/evidence?sort=-captured_at
```

```json
{
  "data": [
    {
      "id": 302,
      "registration_check_id": 131,
      "worker_id": 41,
      "type": "screenshot",
      "file_name": "nmc-12A3456E-20261128.png",
      "mime_type": "image/png",
      "file_size": 191044,
      "captured_at": "2026-11-28T09:15:01Z",
      "download_url": "https://hub.hbcompliance.co.uk/api/v2/registration-monitoring/evidence/302/download"
    }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 },
  "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/registration-monitoring/workers/41/evidence?sort=-captured_at&page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/registration-monitoring/workers/41/evidence?sort=-captured_at&page=1", "prev": null, "next": null }
}
```

```
GET /evidence/302/download
```

`200` with the PNG as the body and the headers `Content-Type: image/png`, `Content-Disposition: inline; filename=nmc-12A3456E-20261128.png`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. The same bearer token is needed: the file is never served from a public address.

### 6.6 Read billing

```
GET /billing/usage
```

```json
{
  "data": {
    "currency": "GBP",
    "trial": {
      "starts_at": "2026-10-28",
      "expires_at": "2026-11-28",
      "days_left": null,
      "on_trial": false,
      "expired": true,
      "restricted": false,
      "eligible": true,
      "manual_access_ends_at": null
    },
    "billing_type": "per_candidate",
    "billing_types": [
      { "value": "per_candidate", "label": "Per candidate" },
      { "value": "fixed_monthly", "label": "Fixed monthly" }
    ],
    "allow_billing": true,
    "direct_debit": {
      "gc_created": true,
      "mandate_status": "active",
      "invite_status": "invited",
      "invited_at": "2026-11-02T10:15:00+00:00",
      "has_invitation_sent": true,
      "can_resend_invitation": false,
      "available": true
    },
    "estimate": {
      "month": "November 2026",
      "active_workers": 38,
      "vat_rate_percent": 20,
      "selected": "per_candidate",
      "options": {
        "per_candidate": { "billing_type": "per_candidate", "label": "Per candidate", "tier_label": "26 – 50", "base_amount_pence": 7600, "vat_amount_pence": 1520, "total_amount_pence": 9120, "currency": "GBP" },
        "fixed_monthly": { "billing_type": "fixed_monthly", "label": "Fixed monthly", "tier_label": "Up to 50", "base_amount_pence": 9900, "vat_amount_pence": 1980, "total_amount_pence": 11880, "currency": "GBP" }
      }
    },
    "tiers": {
      "per_candidate": [ { "label": "1 – 25", "price_pence": 250, "currency": "GBP" }, { "label": "26 – 50", "price_pence": 200, "currency": "GBP" } ],
      "fixed_monthly": [ { "label": "Up to 50", "price_pence": 9900, "currency": "GBP" } ]
    }
  }
}
```

The amounts are examples; yours come from the account's pricing tiers. `GET /billing/bills` lists the months already billed and `GET /billing/bills/{id}/invoice` downloads an invoice as a PDF:

```json
{
  "data": [
    {
      "id": 5,
      "bill_number": "HB-2026-0005",
      "period": "October 2026",
      "active_workers": 38,
      "billing_type": "per_candidate",
      "tier_label": "26 – 50",
      "base_amount_pence": 7600,
      "adjustments_total_pence": 0,
      "vat_amount_pence": 1520,
      "total_amount_pence": 9120,
      "currency": "GBP",
      "status": "paid",
      "status_label": "Paid",
      "status_tone": "success",
      "due_at": "2026-11-07",
      "paid_at": "2026-11-05",
      "generated_at": "2026-10-31"
    }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 },
  "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/registration-monitoring/billing/bills?page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/registration-monitoring/billing/bills?page=1", "prev": null, "next": null }
}
```
