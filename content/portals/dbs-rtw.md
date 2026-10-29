# DBS & Right To Work API v2: reference

Base URL: `https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/`. Portal key `dbs-rtw`. Every call needs `Authorization: Bearer <access_token>` (from `POST /auth/token` with the API key) and `Accept: application/json`. The client must have a monitoring account, otherwise every call is `403 portal_unavailable`. Everything is scoped to the key's client.

DBS & Right To Work shares its code with Registration Monitoring, so **conventions, errors, pagination, dates, money and idempotency are exactly those of `registration-monitoring.md` section 1**, and alerts, imports, team, billing, monitoring settings and verification work as described there with the differences below. The records are **monitored workers** (a DBS certificate and/or a right to work check), not Hub candidates; this API does not create them from a Hub candidate or link them to one. A worker that was linked to a Hub candidate elsewhere shows that candidate's `candidate_ref`.

Differences from Registration Monitoring: a worker holds a DBS track, a right to work track or both; monitoring frequency is per track; a track must be named when a worker has both; the portal only sees DBS and right to work workers (a registration worker is `404`).

## Lifecycle: from a worker to an alert

1. **Create a worker** with `POST /workers`: a DBS certificate number (with surname and date of birth), a right to work document (a share code, a passport image, or another document), or both, with the worker's consent. Nothing is checked yet and nothing is charged by the call.
2. **A check runs** at the next scheduled monitoring run, or when you ask for one with `POST /workers/{id}/verify` (`track` `dbs` or `rtw`, required when the worker has both) or `POST /verify/batch`. The call answers `202` with a job id; poll `GET /verify/jobs/{job}`. A DBS check asks the DBS Update Service and stores a certificate PDF; a right to work check asks the Home Office share code service (or reads the passport image) and stores a screenshot. The result is a check row (`GET /workers/{id}/verification?track=`), evidence (`GET /workers/{id}/evidence`) and the worker's `dbs.status` or `rtw.status`.
3. **Webhooks and alerts** follow. A change of status sends `dbs-rtw.dbs.status_changed` or `dbs-rtw.rtw.status_changed` (the first successful result counts as a change from null). Findings raise an alert, send `dbs-rtw.alert.raised` and email the account's notification address: new DBS information, a certificate that holds information, a right to work check that found no right to work or could not verify a passport or share code, and reminders before a right to work or a share code expires. The alert stays open until you acknowledge it.
4. **Re-check** on the schedule you set per track with `PATCH /workers/{id}/monitoring-settings`. A share code is assumed valid for 90 days: renew it with `PUT /workers/{id}/share-code`, or the scheduled run skips the worker.
5. **Billing** is a monthly subscription for the account, shared with Registration Monitoring, not a charge per check: every active worker counts once (`GET /billing/usage`, `GET /billing/bills`). Checks stop when the free trial is over and Direct Debit is not set up; a manual check is then refused with `422 verification_refused`.

Privacy: a worker is not a Hub candidate and is not created from one; the only link is the read only `candidate_ref`. The DBS certificate number is masked to its last four digits on the worker, and masked the same way in a DBS alert's `title` and `description` (`********7890`). Alert titles in the API begin with the worker's name; the `dbs-rtw.alert.raised` webhook carries no name. Evidence files (certificate PDFs, screenshots, passport images) and raw data are personal data.

## 1. Scopes

| Scope | Endpoints |
| --- | --- |
| `dbs-rtw:workers:read` | `GET /workers`, `GET /workers/{id}` |
| `dbs-rtw:workers:write` | `POST /workers`, `PUT` or `PATCH /workers/{id}`, `DELETE /workers/{id}`, `PUT /workers/{id}/share-code`, `PATCH /workers/{id}/monitoring-settings`, `POST /workers/monitoring-settings/bulk` |
| `dbs-rtw:evidence:read` | `GET /workers/{id}/evidence`, `GET /evidence/dbs/{check}`, `GET /evidence/rtw/{check}`, `GET /workers/{id}/evidence/{passport\|document}`, `GET /dbs-checks/{check}/raw-data`, `GET /rtw-checks/{check}/raw-data` |
| `dbs-rtw:verification:read` | `GET /workers/{id}/verification`, `GET /verify/jobs/{job}` |
| `dbs-rtw:verification:write` | `POST /workers/{id}/verify`, `POST /verify/batch` |
| `dbs-rtw:alerts:read` | `GET /alerts`, `GET /alerts/{id}` |
| `dbs-rtw:alerts:write` | `POST /alerts/acknowledge`, `POST /alerts/{id}/acknowledge` |
| `dbs-rtw:imports:read` | `GET /worker-imports`, `GET /worker-imports/template`, `GET /worker-imports/{id}` |
| `dbs-rtw:imports:write` | `POST /worker-imports/preview`, `POST /worker-imports` |
| `dbs-rtw:team:read` | `GET /team/roles` |
| `dbs-rtw:billing:read` | `GET /billing/usage`, `GET /billing/bills`, `GET /billing/bills/{id}/invoice` |

`dbs-rtw:*` and `*` cover all. A `:write` scope does not include its `:read` scope: give both.

## 2. Workers

Worker fields: `id`, `candidate_ref` (null unless linked), `first_name`, `last_name`, `email`, `phone`, `date_of_birth`, `profession`, `is_active`, `consent_given`, `monitoring_start_date`, `notes`, `compliant`, `dbs` (null when not enrolled: `certificate_number` masked to its last 4 digits, `surname`, `status`, `status_label`, `check_frequency`, `last_checked_at`, `next_check_due_at`), `rtw` (null when not enrolled: `document_type`, `status`, `status_label`, `expiry_date`, `share_code_provided_at`, `share_code_expires_at`, `share_code_stale`, `check_frequency`, `last_checked_at`, `next_check_due_at`).

`GET /workers`. Query: `search`, `candidate_ref` (an unknown or other client's ref is `422` on `candidate_ref`), `check_type` (`dbs` or `rtw`), `compliant`, `is_active`, `page`, `per_page`. `GET /workers/{id}`: the worker plus `recent_dbs_checks` (`id`, `checked_at`, `status`, `result`, `has_evidence_pdf`), `recent_rtw_checks` (`id`, `checked_at`, `status` (`has_right`, `no_right`, null), `method`, `result`, `expiry_date`, `has_screenshot`) and `recent_alerts`.

`POST /workers` (`Idempotency-Key`, JSON or multipart with `rtw_passport_image` or `rtw_document_file`): `first_name`, `last_name`, `email`, `date_of_birth` (required with a DBS certificate), `consent_given` (true), `dbs_certificate_number` (12 digits, not already monitored), `dbs_surname`, `rtw_document_type`, `rtw_share_code` (like `ABC DEF GHI`) and the other fields of the Hub form. `201` with the worker. `PUT` or `PATCH /workers/{id}` changes `first_name`, `last_name`, `email`, `phone`, `date_of_birth`, `profession`, `compliance_officer_name`, `notes`, `dbs_surname`. `DELETE /workers/{id}`: `{ "data": { "id", "deleted": true } }`. `PUT /workers/{id}/share-code` (body `rtw_share_code`) renews a share code; a worker not monitored with a share code is `422 not_share_code_worker`.

`PATCH /workers/{id}/monitoring-settings`: `check_frequency` (sets every track the worker is on), `dbs_check_frequency`, `rtw_check_frequency`, `monitoring_start_date`, `is_active`; answer `id`, `is_active`, `monitoring_start_date`, `registration` (null), `dbs`, `rtw` (each `check_frequency`, `next_check_due_at`, or null when not enrolled). The bulk endpoint takes the same fields and `worker_ids`.

## 3. Evidence, verification, alerts, imports, billing

`GET /workers/{id}/evidence` is one paged list (`type` filters; `checked_from` and `checked_to`; `sort` by `checked_at` or `type`): `{ "data": [ { "type", "check_id", "checked_at", "download_url" } ] }` where `type` is `dbs_certificate` (the PDF of a DBS check), `rtw_screenshot` (the screenshot of a right to work check), `passport` or `document` (the uploads made when the worker was added; they have no `check_id` and no `checked_at`). Downloads (`GET /evidence/dbs/{check}`, `GET /evidence/rtw/{check}`, `GET /workers/{id}/evidence/{passport|document}`) stream the file inline with `Cache-Control: private, no-store`; another client's check or worker is `404`. The two raw-data endpoints answer `{ "data": { "format": "json" or "xml", "content": ... } }` (DBS is XML text, right to work is JSON).

`POST /workers/{id}/verify` and `POST /verify/batch` take an optional `track` (`dbs` or `rtw`). A worker enrolled for both needs it (`422 track_required`); any other value is `422 invalid_track`. `GET /workers/{id}/verification?track=dbs|rtw`: the history of that track. `GET /verify/jobs/{job}` has `track` `dbs` or `rtw`. Alerts, imports, team and billing: as in `registration-monitoring.md` (alerts here are the DBS and right to work ones, `type` starting `dbs_` or `rtw_`; the import template lists the DBS and right to work columns).

## 4. Webhooks

Delivery, signature headers and retries are those of Hub webhooks (`/api/v2/webhooks`). Body: `event_id`, `event_type`, `occurred_at`, `data`. Event names are prefixed `dbs-rtw.`. Payloads keep the worker id and carry no `candidate_ref`. Times (`*_at`) are ISO 8601 UTC with `Z`. The Hub endpoint test (`POST /api/v2/webhooks/{id}/test`) is described with the account webhooks; it is not a portal event.

| Event | When | `data` fields |
| --- | --- | --- |
| `dbs.status_changed` | a completed DBS check returned a status different from the stored one (the first successful check too, with `previous_status` null); never for a failed or rejected check | `worker_id`, `dbs_check_id`, `previous_status`, `new_status`, `checked_at` |
| `rtw.status_changed` | a right to work check that reached a result left a status different from the stored one (the first result too); never for a check that ended in an error | `worker_id`, `rtw_check_id`, `previous_status`, `new_status`, `rtw_expiry_date`, `checked_at` |
| `alert.raised` | a DBS or right to work alert was raised (a finding, or an expiry reminder) | `alert_id`, `worker_id`, `candidate_ref`, `type`, `severity`, `title`, `description` |

`alert.raised` is the one payload that carries text, and none of it names the worker: `title` is the alert type's label (for example `DBS new information`), `description` has any DBS certificate number masked to its last four characters, and `worker_id` and `candidate_ref` (null for a worker not linked to a Hub candidate) let you look the worker up with `GET /workers/{id}`. The old v1 endpoints receive different bodies; only the Hub (v2) body is described here.

## 5. v1 to v2

As `registration-monitoring.md` section 5, and in addition:

| v1 | v2 |
| --- | --- |
| `GET /workers?q=` | `?search=` |
| worker has no candidate field | `candidate_ref` (read only) and `?candidate_ref=` filter |
| `PUT /workers/{id}/share-code` for a non-share-code worker `{ message }` 422 | `422 { error: "not_share_code_worker", message }` |
| verify without `track` for a worker on both tracks `{ message }` 422 | `422 { error: "track_required" }`; a wrong track `{ error: "invalid_track" }` |
| evidence index `{ dbs_certificates, rtw_screenshots, uploads }` | `{ "data": { ... } }` |
| raw data `{ format, data }` | `{ "data": { "format", "content" } }` |

## 6. Worked example: from a new worker to a billed month

Base URL `https://hub.hbcompliance.co.uk/api/v2/dbs-rtw`. Every call carries `Authorization: Bearer <access_token>` and `Accept: application/json`. The key has the scopes `dbs-rtw:workers:write`, `:workers:read`, `:verification:write`, `:verification:read`, `:alerts:read`, `:alerts:write`, `:evidence:read` and `:billing:read`.

### 6.1 Create a worker with a DBS certificate and a share code

```
POST /workers
Idempotency-Key: 5a9e2b71-0c3d-4e68-b7f4-1d6c8a2e9f30
Content-Type: application/json
```

```json
{
  "first_name": "Jane",
  "last_name": "Doe",
  "email": "jane.doe@example.com",
  "date_of_birth": "1988-04-17",
  "consent_given": true,
  "dbs_certificate_number": "001234567890",
  "dbs_surname": "Doe",
  "rtw_document_type": "share_code",
  "rtw_share_code": "abc def ghi"
}
```

A passport or another document is sent as `multipart/form-data` with `rtw_passport_image` or `rtw_document_file`. `201 Created`: the certificate number is masked, the share code is stored in upper case (and never returned), nothing has been checked and no check is scheduled yet.

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
    "profession": null,
    "is_active": true,
    "consent_given": true,
    "monitoring_start_date": "2026-10-28",
    "notes": null,
    "compliant": false,
    "dbs": {
      "certificate_number": "********7890",
      "surname": "Doe",
      "status": null,
      "status_label": "Not checked",
      "check_frequency": "monthly",
      "last_checked_at": null,
      "next_check_due_at": null
    },
    "rtw": {
      "document_type": "share_code",
      "status": null,
      "status_label": "Not checked",
      "expiry_date": null,
      "share_code_provided_at": "2026-10-28",
      "share_code_expires_at": "2027-01-26",
      "share_code_stale": false,
      "check_frequency": "monthly",
      "last_checked_at": null,
      "next_check_due_at": null
    }
  }
}
```

A worker with neither a certificate nor a document is refused:

```json
{
  "error": "validation_failed",
  "message": "Enrol the worker for DBS, right to work or both.",
  "details": { "dbs_certificate_number": ["Enrol the worker for DBS, right to work or both."] },
  "request_id": "01JBX4R9T7M2KQ8W5N3E6H1ZPA"
}
```

### 6.2 Ask for the DBS check and follow it

The worker is enrolled for both tracks, so `track` is required.

```
POST /workers/41/verify
Idempotency-Key: 0f8c6d12-9a4b-4e37-8c15-6b2d7a3e1f90
Content-Type: application/json
```

```json
{ "track": "dbs" }
```

`202 Accepted`:

```json
{ "data": { "job_id": 640, "track": "dbs", "status": "pending" } }
```

Without `track` the call is refused with `422`:

```json
{
  "error": "track_required",
  "message": "Send track (dbs or rtw): this worker is enrolled for both.",
  "request_id": "01JBX4SC3N8Q1D7V0M5R2YHE4K"
}
```

```
GET /verify/jobs/640
```

```json
{
  "data": {
    "job_id": 640,
    "track": "dbs",
    "regulator": "dbs",
    "status": "completed",
    "total_workers": 1,
    "processed_count": 1,
    "success_count": 1,
    "failed_count": 0,
    "status_changes_found": 1,
    "started_at": "2026-10-28T09:12:40Z",
    "completed_at": "2026-10-28T09:12:47Z",
    "error_message": null
  }
}
```

`GET /workers/41/verification?track=dbs` now lists the check:

```json
{
  "data": [
    { "id": 120, "checked_at": "2026-10-28T09:12:44Z", "status": "BLANK_NO_NEW_INFO", "result": "success", "has_evidence_pdf": true }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 },
  "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/workers/41/verification?track=dbs&page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/workers/41/verification?track=dbs&page=1", "prev": null, "next": null }
}
```

### 6.3 The webhooks

The first successful check changes the DBS status from nothing to `BLANK_NO_NEW_INFO`, so the endpoint receives `dbs-rtw.dbs.status_changed` (headers `X-Hub-Event`, `X-Hub-Event-Id`, `X-Hub-Delivery-Id`, `X-Hub-Timestamp`, `X-Hub-Signature`):

```json
{
  "event_id": "2d7b9e41-5c0a-4f83-a6e2-8b1f4c3d7a05",
  "event_type": "dbs-rtw.dbs.status_changed",
  "occurred_at": "2026-10-28T09:12:46Z",
  "data": {
    "worker_id": 41,
    "dbs_check_id": 120,
    "previous_status": null,
    "new_status": "BLANK_NO_NEW_INFO",
    "checked_at": "2026-10-28T09:12:44Z"
  }
}
```

Weeks later the monthly check returns new information. The endpoint receives the status change and, because it raised an alert, `dbs-rtw.alert.raised`:

```json
{
  "event_id": "9c3e5a17-2b6d-4d80-9f14-0a7e8b2c6d51",
  "event_type": "dbs-rtw.alert.raised",
  "occurred_at": "2026-11-28T09:12:48Z",
  "data": {
    "alert_id": 9,
    "worker_id": 41,
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "type": "dbs_new_info",
    "severity": "critical",
    "title": "DBS new information",
    "description": "The DBS Update Service reports new information for certificate ********7890. Request a new DBS certificate before the worker continues."
  }
}
```

### 6.4 Read and acknowledge the alert

```
GET /alerts?acknowledged=false&severity=critical
```

```json
{
  "data": [
    {
      "id": 9,
      "type": "dbs_new_info",
      "type_label": "DBS new information",
      "severity": "critical",
      "title": "Jane Doe - DBS new information",
      "description": "The DBS Update Service reports new information for certificate ********7890. Request a new DBS certificate before the worker continues.",
      "previous_status": "BLANK_NO_NEW_INFO",
      "new_status": "NEW_INFO",
      "acknowledged": false,
      "acknowledged_at": null,
      "created_at": "2026-11-28T09:12:47Z",
      "registration_check_id": null,
      "worker": { "id": 41, "name": "Jane Doe", "regulator": null, "registration_number": null }
    }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 },
  "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/alerts?acknowledged=false&severity=critical&page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/alerts?acknowledged=false&severity=critical&page=1", "prev": null, "next": null }
}
```

`POST /alerts/9/acknowledge` answers `200` with the same alert, now `"acknowledged": true` and `"acknowledged_at": "2026-11-28T10:02:11Z"`.

### 6.5 Download the evidence

```
GET /workers/41/evidence?type=dbs_certificate
```

```json
{
  "data": [
    {
      "type": "dbs_certificate",
      "check_id": 121,
      "checked_at": "2026-11-28T09:12:44Z",
      "download_url": "https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/evidence/dbs/121"
    },
    {
      "type": "dbs_certificate",
      "check_id": 120,
      "checked_at": "2026-10-28T09:12:44Z",
      "download_url": "https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/evidence/dbs/120"
    }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 2, "last_page": 1, "from": 1, "to": 2 },
  "links": { "first": "https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/workers/41/evidence?type=dbs_certificate&page=1", "last": "https://hub.hbcompliance.co.uk/api/v2/dbs-rtw/workers/41/evidence?type=dbs_certificate&page=1", "prev": null, "next": null }
}
```

```
GET /evidence/dbs/121
```

`200` with the PDF as the body and the headers `Content-Type: application/pdf`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. The same bearer token is needed: the file is never served from a public address. What the Update Service answered is `GET /dbs-checks/121/raw-data`:

```json
{ "data": { "format": "xml", "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>..." } }
```

### 6.6 Read billing

Billing is one subscription for the account, so `GET /billing/usage` and `GET /billing/bills` answer exactly as in `registration-monitoring.md` section 6.6, for example:

```json
{
  "data": {
    "currency": "GBP",
    "trial": { "starts_at": "2026-10-28", "expires_at": "2026-11-28", "days_left": null, "on_trial": false, "expired": true, "restricted": false, "eligible": true, "manual_access_ends_at": null },
    "billing_type": "per_candidate",
    "billing_types": [ { "value": "per_candidate", "label": "Per candidate" }, { "value": "fixed_monthly", "label": "Fixed monthly" } ],
    "allow_billing": true,
    "direct_debit": { "gc_created": true, "mandate_status": "active", "invite_status": "invited", "invited_at": "2026-11-02T10:15:00+00:00", "has_invitation_sent": true, "can_resend_invitation": false, "available": true },
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

The amounts are examples; yours come from the account's pricing tiers. Every active worker counts once, whether it is enrolled for DBS, right to work or both, and whether it was added here or in Registration Monitoring.
