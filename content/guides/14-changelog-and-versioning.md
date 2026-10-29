# Changelog and versioning

This guide explains how the API is versioned, what we treat as a breaking change, how we intend to tell you about changes, and what is in each release. It ends with a section for teams moving from the older per-portal APIs to v2.

## Versioning

The version is part of the path. Every endpoint described in these guides lives under `/api/v2`. A breaking change will be released as a new path version, such as `/api/v3`, and not by changing `/api/v2`. We do not change the meaning of an existing `/api/v2` path in a way that would break a correct integration. If your code works against `/api/v2` today, it should keep working as we add to it.

Two practical consequences follow. First, pin your base URL to `https://hub.hbcompliance.co.uk/api/v2`, so that you move to a new version when you choose to and not by accident. Second, write your code to cope with additions, as described next.

### What counts as breaking

We treat these as breaking, and so they will only happen in a new path version:

- removing an endpoint, a field of a response, a query parameter or an accepted value of a parameter;
- renaming any of those;
- changing the type or the meaning of a field, for example a string that becomes a number, a date format that changes, or a status that means something different;
- making an optional request field required, or adding a new required field or parameter;
- tightening validation so that a request that was valid is refused;
- changing the HTTP status or the `error` code of an existing situation;
- changing how authentication, scopes or signatures work in a way that needs you to change your code;
- changing the format of a list, an error or an event envelope.

### What counts as additive

We treat these as additive, and they can happen at any time within `/api/v2`, without a new version:

- new endpoints and new portals;
- new optional request fields and query parameters, such as a new filter;
- new fields in responses, and new fields inside webhook `data`;
- new values for a field that is a list of states (a new `status`, say), and new webhook events;
- new error codes for situations that are new;
- new response headers;
- more specific `message` text, and changes to the wording of messages generally.

### Writing a tolerant client

Additive changes only help you if your code accepts them. Follow these rules:

- **Ignore fields you do not recognise.** Read the fields you need and leave the rest. Do not fail because a response has an extra key, and do not reject a webhook for the same reason.
- **Handle unknown values.** If you switch on a `status` or an `error` code, have a default branch that does something safe, such as logging it and treating it as a generic failure.
- **Do not depend on the order of keys** in a JSON object, nor on the exact text of a `message`.
- **Do not depend on exact page sizes** other than the one you asked for.
- **Do not assume a list is short.** Always follow `links.next`.
- **Send only documented fields and parameters,** with the documented types.
- **Watch for the headers** `Deprecation` and `Sunset`, which mark an endpoint that is going away. The sample at the end of this section logs them.

### Deprecation

When we intend to remove or change something in a way that would break an integration, we will mark it as deprecated before we do. Some of the older Practical Training endpoints show how this looks in practice: their responses carry a `Deprecation: true` header, a `Sunset` header with a date, and a `Link` header pointing at the replacement with `rel="successor-version"`. We intend to use the same headers, and we will also record the change in this changelog.

We have not published a fixed minimum period of notice yet. When we do, it will be stated here. Until then, treat a `Deprecation` header as the signal to plan a move, and read the changelog when you see one.

The sample below wraps a call so that it logs a warning whenever a response has `Deprecation` or `Sunset` headers, and reads only the fields it needs, which makes it tolerant of additions. Run it with your key in `HB_API_KEY`. It needs the scope `hub:candidates:read`.

### cURL

This prints any deprecation headers of a response.

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

curl --silent --dump-header - --output /dev/null "$BASE/hub/candidates?per_page=1" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json' | grep -i -E '^(HTTP/|deprecation|sunset|link)' || true
```

### JavaScript

```javascript
const BASE = 'https://hub.hbcompliance.co.uk/api/v2';

function warnIfDeprecated(response, label) {
  const deprecation = response.headers.get('deprecation');
  const sunset = response.headers.get('sunset');

  if (deprecation || sunset) {
    console.warn(`DEPRECATED: ${label} (Deprecation: ${deprecation}, Sunset: ${sunset}, Link: ${response.headers.get('link')})`);
  }
}

const tokenResponse = await fetch(`${BASE}/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ api_key: process.env.HB_API_KEY }),
});
warnIfDeprecated(tokenResponse, 'POST /auth/token');
const { access_token: token } = await tokenResponse.json();

const response = await fetch(`${BASE}/hub/candidates?per_page=5`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
warnIfDeprecated(response, 'GET /hub/candidates');

const page = await response.json();

// Read only the fields you use, with safe defaults for anything that may be missing.
const candidates = (page.data ?? []).map((row) => ({
  ref: row.candidate_ref,
  name: row.name ?? `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
  status: row.compliance_status ?? 'unknown',
}));

console.log(candidates);
```

### PHP

```php
<?php

const HB_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

/** @return array{0: int, 1: array<string, string>, 2: mixed} */
function hb_call(string $method, string $path, ?string $token = null, ?array $json = null): array
{
    $responseHeaders = [];
    $headers = ['Accept: application/json'];

    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
    }

    $curl = curl_init(HB_BASE . $path);
    curl_setopt_array($curl, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_HEADERFUNCTION => function ($handle, string $line) use (&$responseHeaders): int {
            $parts = explode(':', $line, 2);

            if (count($parts) === 2) {
                $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
            }

            return strlen($line);
        },
    ]);

    if ($json !== null) {
        curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($json));
    }

    $raw = curl_exec($curl);

    if ($raw === false) {
        throw new RuntimeException('Network error: ' . curl_error($curl));
    }

    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);

    return [$status, $responseHeaders, json_decode($raw, true)];
}

/** @param array<string, string> $headers */
function warn_if_deprecated(array $headers, string $label): void
{
    if (isset($headers['deprecation']) || isset($headers['sunset'])) {
        fwrite(STDERR, sprintf(
            "DEPRECATED: %s (Deprecation: %s, Sunset: %s, Link: %s)\n",
            $label,
            $headers['deprecation'] ?? '-',
            $headers['sunset'] ?? '-',
            $headers['link'] ?? '-',
        ));
    }
}

[$status, $headers, $tokenAnswer] = hb_call('POST', '/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')]);
warn_if_deprecated($headers, 'POST /auth/token');

if ($status !== 200) {
    exit("Token exchange failed: {$tokenAnswer['error']}\n");
}

[, $headers, $page] = hb_call('GET', '/hub/candidates?per_page=5', $tokenAnswer['access_token']);
warn_if_deprecated($headers, 'GET /hub/candidates');

// Read only the fields you use, with safe defaults for anything that may be missing.
$candidates = array_map(fn (array $row): array => [
    'ref' => $row['candidate_ref'] ?? null,
    'name' => $row['name'] ?? trim(($row['first_name'] ?? '') . ' ' . ($row['last_name'] ?? '')),
    'status' => $row['compliance_status'] ?? 'unknown',
], $page['data'] ?? []);

print_r($candidates);
```

### Python

```python
import os

import requests

BASE = "https://hub.hbcompliance.co.uk/api/v2"


def warn_if_deprecated(response, label):
    deprecation = response.headers.get("Deprecation")
    sunset = response.headers.get("Sunset")

    if deprecation or sunset:
        print(f"DEPRECATED: {label} (Deprecation: {deprecation}, Sunset: {sunset}, Link: {response.headers.get('Link')})")


token_response = requests.post(
    f"{BASE}/auth/token",
    json={"api_key": os.environ["HB_API_KEY"]},
    headers={"Accept": "application/json"},
    timeout=30,
)
warn_if_deprecated(token_response, "POST /auth/token")
token = token_response.json()["access_token"]

response = requests.get(
    f"{BASE}/hub/candidates",
    params={"per_page": 5},
    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    timeout=30,
)
warn_if_deprecated(response, "GET /hub/candidates")

# Read only the fields you use, with safe defaults for anything that may be missing.
candidates = [
    {
        "ref": row.get("candidate_ref"),
        "name": row.get("name") or f"{row.get('first_name', '')} {row.get('last_name', '')}".strip(),
        "status": row.get("compliance_status", "unknown"),
    }
    for row in response.json().get("data", [])
]

print(candidates)
```

With the current API none of these print a deprecation warning, because nothing in `/api/v2` is deprecated.

## Changelog

### Training Verification, October 2026 (additive)

A tenth portal, `training-verification`, is added under `/api/v2` (11 operations, 7 webhook events). The specification now describes 200 operations and 66 webhook events; nothing existing changed and every existing operation id is the same. The portal is described on its [page](../portals/training-verification.md).

* **Endpoints.** `profile.show`, `pricing.show`, `credits.show`, `credits.transactions`, `verifications.create` (`202 Accepted`, `Idempotency-Key`), `verifications.list`, `verifications.show`, `verifications.events`, `verifications.certificate`, `verifications.report`, `verifications.cancel`.
* **Scopes.** `training-verification:read` and `training-verification:write` (write also grants read), `training-verification:*` for the portal. They are the first scopes without a resource part: `{portal}:{read|write}`.
* **Webhook events.** `training-verification.submitted`, `.processing`, `.verified`, `.not_found`, `.rejected`, `.failed` and `.refunded`, each at most once per verification. Their `data` carries ids, statuses, a public reason code, timestamps and the candidate name the client supplied.
* **Payment.** The API charges the client's credits and balances only, by the same rules as the Hub form: a regular account's automated verification is free; manual verification, and every verification of a verification-only account, is charged. A shortfall is `402 insufficient_credits` with `details.required` and `details.available`. There is no card payment through the API.

### 2.0.0, October 2026

The first release of the v2 API. It is one API for every portal, with one way to sign in, one list format, one error format and one webhook system. The machine-readable specification (`hub-v2.json`, see [SDKs and tools](15-sdk-and-tools.md)) describes it with 163 paths, 186 operations and 59 webhook events.

**Authentication** (4 operations). `POST /auth/token` exchanges an API key for an access token (60 minutes) and a refresh token (7 days). `POST /auth/refresh` renews the pair, and each refresh token works once. `POST /auth/revoke` ends a pair. `GET /auth/me` shows the key behind a token. There are no separate sign-in endpoints in the portals.

**Account** (10 operations). Webhook management: list, create, read, update and delete endpoints, list the available events, send a test event, rotate the signing secret, list deliveries and redeliver. One webhook system serves every portal.

**Hub core** (4 operations). Candidates: list, read, create and update, all addressed by `candidate_ref`, the one identifier every portal API uses for a person.

**Portals** (nine):

| Portal | Operations | Notes |
| --- | --- | --- |
| Online Training | 14 | Candidates and their courses by `candidate_ref`, results, certificates, reminder emails, six webhook events |
| Occupational Health | 27 | Requests, candidates, documents, alerts, reports, credits, nine webhook events. The submission flow for candidates and agencies is not in v2 yet |
| Practical Training | 20 | Catalogue, holds, bookings, booking invitations, credits, sixteen webhook events |
| Virtual BLS Training | 14 | Catalogue, holds, bookings, credits, seven webhook events |
| Clinical Interviews | 13 | Interview types, holds, bookings, interview reports, credits, seven webhook events |
| Clinical Appraisals | 8 | Appraisal types, bookings, evaluation reports, credits, two webhook events |
| References | 11 | Reference requests, referees, templates, seven webhook events |
| Registration Monitoring | 29 | Workers, evidence, verification, alerts, imports, billing, two webhook events |
| DBS and Right To Work | 32 | The same areas for DBS and right to work checks, with share codes, three webhook events |
| Training Verification | 11 | Added after 2.0.0 (see the entry above): verifications, results, events, certificate, report, cancel, credits, seven webhook events |

**Conventions** shared by all of the above, as described in these guides: a `{ data }` envelope for single records and `{ data, meta, links }` for lists, `page`, `per_page` (1 to 100, default 25), `sort`, `search` and `{field}_from` and `{field}_to` filters, dates in ISO 8601 UTC with a `Z`, money in integer pence with a `currency`, errors as `{ error, message, details, request_id }` with an `X-Request-Id` header, `Idempotency-Key` on creating calls, hourly rate limits per key with `X-RateLimit-*` headers, scopes of the form `{portal}:{resource}:{read|write}` where a write scope implies the matching read scope, and an optional IP allowlist per key.

Future releases will be listed above this one, newest first. Each entry will say whether a change is additive or breaking and which endpoints it touches.

## Migrating from the v1 portal APIs

Before v2, each portal had its own API with its own address, sign-in, list format and error format. Those APIs, now called v1 here, keep working unchanged, and nothing in v2 requires you to move on a particular date. This section is a summary for teams that choose to migrate. The per-portal pages in [the portals folder](../portals/) each end with a table that maps every old endpoint to its new one, and they are the place to look for detail.

### What changes everywhere

| Area | v1 | v2 |
| --- | --- | --- |
| Sign-in | A client id and an API key, exchanged at an endpoint inside each portal | The API key alone, at `POST /api/v2/auth/token`, for every portal. Refresh at `/api/v2/auth/refresh`, and `auth/me` and `auth/revoke` replace the old token-info and revoke calls |
| Candidates | An integer id, or a uuid specific to the portal | `candidate_ref`, one uuid for the person in every portal. Candidates are created in the Hub core API |
| Single records | A bare object | `{ "data": { ... } }` |
| Lists | `meta` with `current_page`, `last_page` and a default page size of 20 or 50 | `meta` with `page`, `per_page`, `total`, `last_page`, `from`, `to`, plus `links`. Default 25, at most 100 |
| Errors | `{ "message": "..." }`, sometimes with a code in capitals | `{ "error": "snake_case_code", "message": "...", "details": {...}, "request_id": "..." }` |
| Dates and times | Several formats, some with UK offsets such as `+01:00` | ISO 8601 UTC with a `Z`. Dates without a time as `YYYY-MM-DD` |
| Money | Pounds as decimal numbers, in some portals | Integer pence with a `currency`, in fields ending `_pence` |
| Credits | Units | Still units, never money. Money has its own fields, named `_pence`, next to a `currency` |
| Date filters | `date_from`, `date_to`, `created_after` and others | `{field}_from` and `{field}_to`, named for the field, for example `start_date_from` and `created_to` |
| Text search | `q` in some portals | `search` |
| Webhooks | Endpoints managed in each portal, each with its own signature header and body, often with the candidate's name and email | One system at `/api/v2/webhooks`, one signing secret, `X-Hub-Signature`, and bodies with ids, statuses and the `candidate_ref` and no personal data |
| Idempotency | None | `Idempotency-Key` on creating calls |
| Rate limits | Per portal | A per-key hourly limit with headers, plus a few per-minute throttles |

### Portal by portal

**Online Training.** Candidates are addressed by `candidate_ref`. v1 created a candidate and assigned courses in one call. In v2 you create the candidate with `POST /hub/candidates` and then assign courses with `PUT /online-training/candidates/{candidate_ref}/courses`. The old callbacks, which posted a result to a `callback_url`, are replaced by the webhook events `online-training.course.completed` and `online-training.training.completed`. A course result that does not exist is now `404`, where v1 answered `204`. Certificate types such as `incl_expired` are written `incl-expired`.

**Occupational Health.** Requests have one stable `id` (the reference is `OH-{id}`), and a candidate is `candidate_ref`. Creating a request takes `candidate_ref` and the clearance details. The step where an agency submits a candidate's answers and documents (the submission flow of v1) is not in v2 yet: until it is, that part of the agency integration stays on v1.

**Practical Training.** A booking takes `candidate_ref` instead of the attendee's first name, last name, email, phone and job role, which now come from the Hub candidate. Amounts such as `cost_inc_vat` become `cost_inc_vat_pence`, and the booking balance is `booking_balance_pence`. `date_from` and `date_to` become `start_date_from` and `start_date_to`. A hold conflict is `409 conflict` with the existing hold in `hold`. Booking links are now booking invitations (`/booking-invites`), with create, read and withdraw. The public feeds of sessions are not part of v2.

**Virtual BLS Training.** The changes follow Practical Training: `candidate_ref` for the person, pence for money, `start_date_from` and `start_date_to`, and times in UTC with a `Z` where v1 used the UK offset. The timeslot list is paged. A reschedule that needs a payment answers `402 payment_required` with a `payment_url`.

**Clinical Interviews and Clinical Appraisals.** Credits and transactions have moved to the `credits` scope, away from `account`. Bookings take `candidate_ref`. Money is in pence with a `currency`, and the credit and type fields use `interview_type_id` and `appraisal_type_id`, replacing the old `course_id`. Errors use snake case codes such as `slot_taken`, and a hold conflict is `409 hold_exists`. Webhook bodies no longer carry the whole booking or the candidate's details.

**References.** A request is created with `candidate_ref`, where v1 took `candidate_id`, and lists filter by `candidate_ref`. `created_after` and `created_before` become `created_from` and `created_to`. A candidate who is not yours is now `422` on `candidate_ref`, not `403`. Webhook bodies drop the referee's name, email and decline reason.

**Registration Monitoring.** Lists use `search` instead of `q` and the standard page size and `meta`. A worker gains a read-only `candidate_ref` and a filter for it. Actions answer with `{ "data": { ... } }` in place of `{ "message": ... }`, and billing amounts carry a `currency`.

**DBS and Right To Work.** This portal had no earlier API, so there is nothing to migrate. It follows the same conventions as Registration Monitoring.

### Retired v1 endpoints

A few v1 endpoints do nothing useful any more and have been marked retired (29 October 2026). They are not in v2, nothing replaces most of them, and you should not build on them. They keep answering for now; before any of them is removed we will say so in this changelog first.

| v1 endpoint | What to do |
| --- | --- |
| Practical Training `GET /api/tdta/trainingstoday` | Unauthenticated feed of today's sessions. Use `GET /api/v2/practical-training/training-events` for sessions |
| Clinical Interviews `GET /booking-url` | Always returned `null`: Interviews has no public booking page |
| Clinical Appraisals `GET /booking-url`, `GET /timeslots`, `POST /timeslots/hold`, `DELETE /timeslots/hold/{holdHash}` | Stubs that never returned anything useful: an appraisal has no timeslot or hold |
| Clinical Appraisals `POST /bookings` (v1, after a hold) | Never succeeds. Use `POST /api/v2/clinical-appraisals/bookings`, which takes no hold |
| Occupational Health `ANY /api/candidate-interview/{uuid}` | No v2 equivalent; the document links pointed at the old portal |

### Suggested approach

Move one portal at a time. Start with authentication, because it is the same for every portal, and replace the sign-in code with the token manager from [authentication](02-authentication.md). Then move candidate handling to `candidate_ref`: create candidates through the Hub core API and keep a mapping from your own ids to `candidate_ref`s. Then switch each portal's calls, one table at a time, and move your webhook receivers last, verifying the new signature as described in [webhooks](10-webhooks.md). Run v1 and v2 side by side while you check results. When a portal is fully moved, remove its old sign-in and any stored v1 tokens.

If a v1 call has no v2 equivalent in the portal's mapping table, it is not available in v2 yet. The occupational health submission flow is the main example. Keep using v1 for that call and ask us about it before you plan around it.
