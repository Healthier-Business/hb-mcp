# Candidates and `candidate_ref`

Almost everything you do through the Hub API is about people: assigning training to them, booking them onto sessions, requesting occupational health clearance, monitoring their registration. This guide explains how the API identifies a person, how to create and update candidates, and how to use the same identifier in every portal.

## The idea

A candidate belongs to your organisation in the Hub, not to any single portal. The Hub gives every candidate one **`candidate_ref`**: a uuid such as `78572976-3a12-417c-9a26-f88938703800`. It never changes once it exists. Every portal API uses that same value wherever it needs to name a person, whether that is a path (`/online-training/candidates/{candidate_ref}`), a field in a request body (`"candidate_ref": "..."`), a filter (`?candidate_ref=...`) or a field in a webhook.

This is deliberate. You create a person once, in the Hub core API, and then you can assign them online training, book them onto practical training, raise an occupational health request and add them to registration monitoring, all with the same reference. You never need to store a separate id for each portal, and you never need to look one up.

Integer candidate ids that the portals use internally do not appear anywhere in the v2 API, in paths, bodies, responses or webhooks. If you are migrating from the older portal APIs, which used integer ids or their own uuids, see [changelog and versioning](14-changelog-and-versioning.md).

## The Hub candidate endpoints

The Hub core API is at `/api/v2/hub/`. It has four endpoints for candidates:

| Method and path | Scope | Purpose |
| --- | --- | --- |
| `GET /hub/candidates` | `hub:candidates:read` | List candidates, with filters and paging |
| `GET /hub/candidates/{candidate_ref}` | `hub:candidates:read` | Read one candidate, with compliance counts and the services they have |
| `POST /hub/candidates` | `hub:candidates:write` | Add a candidate |
| `PATCH /hub/candidates/{candidate_ref}` | `hub:candidates:write` | Change a candidate, or make them active or inactive |

A `:write` scope also grants the matching `:read`, so a key with `hub:candidates:write` can list and read candidates too.

### Creating a candidate

`POST /hub/candidates` adds a candidate in exactly the way the Add Candidate page in the Hub does. The body fields are:

| Field | Rule |
| --- | --- |
| `first_name` | Required, up to 100 characters |
| `last_name` | Required, up to 100 characters |
| `email` | Required, a valid address of up to 191 characters. It must not already belong to another candidate of your organisation |
| `phone` | Optional, up to 50 characters |
| `roles` | Optional list of up to 10 roles, each up to 100 characters |
| `specialties` | Optional list of up to 10 specialties, each up to 100 characters |
| `candidate_reference` | Optional. Your own reference for the person (a staff number, say), up to 100 characters. Not the same as `candidate_ref` |
| `compliance_officer` | Optional, the name of your compliance officer for this candidate, up to 150 characters |
| `is_active` | Optional, default `true`. Send `false` to add the candidate as inactive |

Two details are easy to miss. First, unless you send `"is_active": false`, the candidate is emailed an activation link for their account, exactly as if you had added them in the Hub (no email goes out either when your account is set to activate candidates by hand; you can send it later from the Emails menu on the candidate page, and a failure to send never undoes the candidate). If you are testing or loading historic people and do not want email to go out, add them as inactive and make them active later. Second, a new candidate has no services set up: every service starts as `not_required` until you assign something to them through a portal API.

The answer is `201` and holds the new `candidate_ref`:

```json
{
  "data": {
    "candidate_ref": "78572976-3a12-417c-9a26-f88938703800",
    "first_name": "Ann",
    "last_name": "Lee",
    "name": "Ann Lee",
    "email": "ann.lee@example.com",
    "phone": "07700 900123",
    "roles": ["Registered Nurse"],
    "specialties": ["Theatre"],
    "candidate_reference": "STAFF-0042",
    "compliance_officer": "Sam Patel",
    "is_active": true,
    "compliance_status": "na",
    "next_expiry_date": null,
    "added_at": "2026-10-28T19:53:24Z",
    "updated_at": "2026-10-28T19:53:24Z",
    "compliance": { "compliant": 0, "expiring_soon": 0, "expired": 0 },
    "services": [
      { "service": "online-training", "label": "Online Training", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "practical-training", "label": "Practical Training", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "virtual-bls-training", "label": "Virtual BLS Training", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "occupational-health", "label": "Occupational Health", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "references", "label": "References", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "registration-monitoring", "label": "Registration Monitoring", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "dbs-rtw", "label": "DBS & Right To Work", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "clinical-interviews", "label": "Clinical Interviews", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "clinical-appraisals", "label": "Clinical Appraisals", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null },
      { "service": "nmc-revalidations", "label": "NMC Revalidations", "management": "not_required", "status": "na", "completed_at": null, "next_expiry_date": null, "portal_id": null }
    ]
  }
}
```

The values of `compliance_status` and `status` shown here are illustrative. The candidate detail always has the ten `services` rows, in this order. `management` says who runs the service: `hb` (Healthier Business), `client` (you) or `not_required`. `portal_id` is the identifier the portal itself uses for the person's record. It is shown for information only and you never need it to call an API.

### Creating a candidate safely: idempotency

Creating a candidate is a write that you may well want to retry, for example when a network error leaves you not knowing whether the call went through. Send an `Idempotency-Key` header with a fresh value for each distinct candidate. If you repeat the call with the same key and the same body within 24 hours, you get the first answer back with the header `Idempotent-Replayed: true`, and no second candidate is created. If you reuse the key with a different body, you get `409 idempotency_conflict`. Guide [07, idempotency](07-idempotency.md) covers the details.

### Duplicates

An email address can belong to only one candidate of your organisation. If you create a candidate whose email already exists, the answer is `422 validation_failed` with the field named in `details`:

```json
{
  "error": "validation_failed",
  "message": "A candidate with this email already exists for this client.",
  "details": { "email": ["A candidate with this email already exists for this client."] },
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

This is how you de-duplicate. When you meet it, look the person up with `GET /hub/candidates?search=ann.lee@example.com`, which matches on name, email, role and your own `candidate_reference`, and use the `candidate_ref` you find. The `Idempotency-Key` does not replace this check: it protects you from repeating one request, while the email rule protects the Hub from two different requests for one person.

### Updating a candidate

`PATCH /hub/candidates/{candidate_ref}` changes only the fields you send. It accepts `first_name`, `last_name`, `email`, `phone`, `roles`, `specialties`, `candidate_reference`, `compliance_officer` and `is_active`. An `email` that belongs to another candidate of yours is refused with `422` on `email`. Setting `is_active` to `false` makes the candidate inactive and `true` makes them active again, as the buttons in the Hub do. There is no delete or archive endpoint: making a candidate inactive is the equivalent.

```bash
curl --silent "https://hub.hbcompliance.co.uk/api/v2/hub/candidates/78572976-3a12-417c-9a26-f88938703800" \
  --request PATCH \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data '{"phone": "07700 900456", "roles": ["Senior Nurse"]}'
```

The answer is `200` with the updated candidate in the same shape as the create answer.

## Using the `candidate_ref` in the portal APIs

Every portal takes the reference in one of three ways.

| Portal | How `candidate_ref` is used |
| --- | --- |
| Online Training | The key of `/online-training/candidates/{candidate_ref}` and everything under it. Assigning courses is `PUT /online-training/candidates/{candidate_ref}/courses` |
| Occupational Health | The key of `/occupational-health/candidates/{candidate_ref}` (read only), and a field of `POST /occupational-health/requests` |
| Practical Training and Virtual BLS Training | A field of `POST /bookings`, returned on every booking and invitation, and a filter of the booking lists |
| Clinical Interviews and Clinical Appraisals | A field of `POST /bookings`, returned on every booking and a filter |
| References | A field of `POST /requests`, returned on every request and a filter |
| Training Verification | An optional field of `POST /verifications` (validated: it must be your candidate), returned on every verification and a filter. A candidate of another account matched on the certificate is never exposed |
| Registration Monitoring and DBS and Right To Work | A field of `POST /workers` linking the worker to a Hub candidate, returned on every worker and a filter |

Candidate creation exists only in the Hub core API. A portal never creates a person for you. If you try to book, assign or request for a person who does not exist yet, you first call `POST /hub/candidates`.

### Unknown and other-client references

A reference is only valid for the organisation that owns the candidate. The API deliberately gives the same answer for "this uuid does not exist" and "this uuid belongs to someone else", so nobody can probe for other organisations' people. How the answer looks depends on where you put the reference:

- **In a path**, an unknown reference, a reference belonging to another client and a value that is not a uuid at all are all `404 not_found`.
- **In a request body**, a reference that is not one of your candidates is `422 validation_failed` with the field `candidate_ref` in `details`. Practical Training bookings and invitations, and Occupational Health requests, work this way.
- **As a list filter** (`?candidate_ref=...`) the behaviour is documented per portal. Online Training answers an unknown or foreign reference with an empty list. Other portals may treat it as a validation error, so check the portal page.

Do not try to tell the two cases apart. If a reference you were sure about is refused, check that you are using the key of the organisation that created the candidate.

### What the per-portal calls need from the candidate

Each portal reads what it needs from the Hub candidate. A Practical Training booking, for example, takes the attendee's name, email, phone and job role from the candidate, and answers `422` on `candidate_ref` if the candidate has no first name, email address or phone number (the message names what is missing). Fix this with a `PATCH` on the candidate, not by sending those fields to the portal. Details are in each portal's page in [the portals folder](../portals/).

## A worked example: add a candidate and assign online training

The next samples create a candidate with an idempotency key, handle the duplicate case by finding the existing candidate, then assign an Online Training course to the person using the same `candidate_ref`. `PUT /online-training/candidates/{candidate_ref}/courses` sets the exact list of courses the candidate should have. Course ids come from `GET /online-training/courses`. The key needs `hub:candidates:write` and `online-training:candidates:write`.

The first time a Hub candidate is given training, the Online Training record for the person is created in the same call and the candidate is emailed their activation link, as in the Hub, unless you send `"send_activation_email": false`.

### cURL

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

IDEMPOTENCY_KEY=$(uuidgen)

CANDIDATE_REF=$(curl --silent --fail-with-body "$BASE/hub/candidates" \
  --request POST \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header "Idempotency-Key: $IDEMPOTENCY_KEY" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data '{
    "first_name": "Ann",
    "last_name": "Lee",
    "email": "ann.lee@example.com",
    "phone": "07700 900123",
    "roles": ["Registered Nurse"],
    "candidate_reference": "STAFF-0042"
  }' | jq --raw-output '.data.candidate_ref')

echo "candidate_ref: $CANDIDATE_REF"

curl --silent --fail-with-body "$BASE/online-training/candidates/$CANDIDATE_REF/courses" \
  --request PUT \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data '{"course_ids": [12], "renewal_mode": "auto", "send_reminders": true}'
```

If the email already exists, the first `curl` exits with an error and the shell variable stays empty. In a script, use the lookup shown in the other languages below.

### JavaScript

```javascript
import { randomUUID } from 'node:crypto';

const BASE = 'https://hub.hbcompliance.co.uk/api/v2';

async function call(method, path, token, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const tokenAnswer = await call('POST', '/auth/token', null, { api_key: process.env.HB_API_KEY });
if (tokenAnswer.status !== 200) {
  throw new Error(`Token exchange failed: ${tokenAnswer.body?.error}`);
}
const token = tokenAnswer.body.access_token;

const person = {
  first_name: 'Ann',
  last_name: 'Lee',
  email: 'ann.lee@example.com',
  phone: '07700 900123',
  roles: ['Registered Nurse'],
  candidate_reference: 'STAFF-0042',
};

let created = await call('POST', '/hub/candidates', token, person, { 'Idempotency-Key': randomUUID() });
let candidateRef;

if (created.status === 201) {
  candidateRef = created.body.data.candidate_ref;
} else if (created.status === 422 && created.body.details?.email) {
  const found = await call('GET', `/hub/candidates?search=${encodeURIComponent(person.email)}`, token);
  const match = found.body.data.find((candidate) => candidate.email.toLowerCase() === person.email);
  if (!match) {
    throw new Error('The email is in use but the candidate could not be found.');
  }
  candidateRef = match.candidate_ref;
} else {
  throw new Error(`Could not create the candidate: ${created.body?.error} (request ${created.body?.request_id})`);
}

console.log('candidate_ref:', candidateRef);

const assigned = await call('PUT', `/online-training/candidates/${candidateRef}/courses`, token, {
  course_ids: [12],
  renewal_mode: 'auto',
  send_reminders: true,
});

console.log(assigned.status, JSON.stringify(assigned.body, null, 2));
```

### PHP

```php
<?php

const HB_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

function hb_call(string $method, string $path, ?string $token = null, ?array $json = null, array $extraHeaders = []): array
{
    $headers = ['Accept: application/json', ...$extraHeaders];

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

    return [$status, json_decode($raw, true)];
}

function uuid_v4(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
}

[$status, $tokenAnswer] = hb_call('POST', '/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')]);

if ($status !== 200) {
    exit("Token exchange failed: {$tokenAnswer['error']}\n");
}

$token = $tokenAnswer['access_token'];

$person = [
    'first_name' => 'Ann',
    'last_name' => 'Lee',
    'email' => 'ann.lee@example.com',
    'phone' => '07700 900123',
    'roles' => ['Registered Nurse'],
    'candidate_reference' => 'STAFF-0042',
];

[$status, $created] = hb_call('POST', '/hub/candidates', $token, $person, ['Idempotency-Key: ' . uuid_v4()]);

if ($status === 201) {
    $candidateRef = $created['data']['candidate_ref'];
} elseif ($status === 422 && isset($created['details']['email'])) {
    [, $found] = hb_call('GET', '/hub/candidates?search=' . rawurlencode($person['email']), $token);
    $candidateRef = null;

    foreach ($found['data'] as $candidate) {
        if (strtolower($candidate['email']) === $person['email']) {
            $candidateRef = $candidate['candidate_ref'];
        }
    }

    if ($candidateRef === null) {
        exit("The email is in use but the candidate could not be found.\n");
    }
} else {
    exit("Could not create the candidate: {$created['error']} (request {$created['request_id']})\n");
}

echo "candidate_ref: {$candidateRef}\n";

[$status, $assigned] = hb_call('PUT', "/online-training/candidates/{$candidateRef}/courses", $token, [
    'course_ids' => [12],
    'renewal_mode' => 'auto',
    'send_reminders' => true,
]);

echo $status, ' ', json_encode($assigned, JSON_PRETTY_PRINT), "\n";
```

### Python

```python
import os
import sys
import uuid
from urllib.parse import quote

import requests

BASE = "https://hub.hbcompliance.co.uk/api/v2"


def call(method, path, token=None, body=None, headers=None):
    request_headers = {"Accept": "application/json", **(headers or {})}
    if token:
        request_headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, f"{BASE}{path}", json=body, headers=request_headers, timeout=30)


token_answer = call("POST", "/auth/token", body={"api_key": os.environ["HB_API_KEY"]})
if token_answer.status_code != 200:
    sys.exit(f"Token exchange failed: {token_answer.json().get('error')}")
token = token_answer.json()["access_token"]

person = {
    "first_name": "Ann",
    "last_name": "Lee",
    "email": "ann.lee@example.com",
    "phone": "07700 900123",
    "roles": ["Registered Nurse"],
    "candidate_reference": "STAFF-0042",
}

created = call("POST", "/hub/candidates", token, person, {"Idempotency-Key": str(uuid.uuid4())})

if created.status_code == 201:
    candidate_ref = created.json()["data"]["candidate_ref"]
elif created.status_code == 422 and "email" in created.json().get("details", {}):
    found = call("GET", f"/hub/candidates?search={quote(person['email'])}", token).json()
    matches = [c for c in found["data"] if c["email"].lower() == person["email"]]
    if not matches:
        sys.exit("The email is in use but the candidate could not be found.")
    candidate_ref = matches[0]["candidate_ref"]
else:
    body = created.json()
    sys.exit(f"Could not create the candidate: {body.get('error')} (request {body.get('request_id')})")

print("candidate_ref:", candidate_ref)

assigned = call(
    "PUT",
    f"/online-training/candidates/{candidate_ref}/courses",
    token,
    {"course_ids": [12], "renewal_mode": "auto", "send_reminders": True},
)
print(assigned.status_code, assigned.text)
```

The assignment answers `200` with the result of the call:

```json
{
  "data": {
    "candidate_ref": "78572976-3a12-417c-9a26-f88938703800",
    "added_course_ids": [12],
    "removed_course_ids": [],
    "credits_charged": 0,
    "candidate": {
      "candidate_ref": "78572976-3a12-417c-9a26-f88938703800",
      "first_name": "Ann",
      "last_name": "Lee",
      "email": "ann.lee@example.com",
      "phone": "07700 900123",
      "job_role": "Registered Nurse",
      "client_record_id": "STAFF-0042",
      "account_status": "pending",
      "training_status": "not_completed",
      "courses_assigned": 1,
      "courses_completed": 0,
      "courses_expired": 0,
      "paid_by": "client",
      "renewal_mode": "auto",
      "completed_at": null,
      "expires_at": null
    }
  }
}
```

The course id `12` is an example: list the courses your account may assign with `GET /online-training/courses` and use those ids. Fields such as `job_role` and `client_record_id` are described on the [Online Training page](../portals/online-training.md), which also lists the errors, such as `402 insufficient_credits`.

## The same reference in other portals

Once you have a `candidate_ref`, the other portals take it in the same way. Two short cURL examples show the pattern. Each assumes `$ACCESS_TOKEN` and `$CANDIDATE_REF` are set.

Invite a candidate to book Practical Training (scope `practical-training:bookings:write`; the account must have booking invitations switched on, otherwise the answer is `403 invites_not_enabled`):

```bash
curl --silent "https://hub.hbcompliance.co.uk/api/v2/practical-training/booking-invites" \
  --request POST \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header "Idempotency-Key: $(uuidgen)" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data "{\"candidate_ref\": \"$CANDIDATE_REF\", \"contact_name\": \"Sam Patel\", \"contact_email\": \"sam.patel@example.com\"}"
```

Raise an Occupational Health request (scope `occupational-health:requests:write`). The fields that are required depend on the clearance type, which you read from `GET /occupational-health/clearance-types` and `GET /occupational-health/request-options`:

```bash
curl --silent "https://hub.hbcompliance.co.uk/api/v2/occupational-health/requests" \
  --request POST \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header "Idempotency-Key: $(uuidgen)" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data "{\"candidate_ref\": \"$CANDIDATE_REF\", \"request_type\": \"new_starter\", \"clearance_type_id\": 3, \"scope\": \"full\", \"hq_method\": \"online\", \"imms_method\": \"candidate\"}"
```

In both cases a reference that is not one of your candidates answers `422 validation_failed` with `candidate_ref` in `details`.

## Next steps

Read [scopes and permissions](04-scopes-and-permissions.md) to choose scopes for a key that creates candidates and uses portals, and [idempotency](07-idempotency.md) for safe retries. To be told when something happens to a candidate, such as a course being completed, use [webhooks](10-webhooks.md): every event carries the `candidate_ref`.
