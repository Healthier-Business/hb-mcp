# Idempotency

Networks fail in an awkward way. You send a request to create something, the connection drops, and you do not know whether the server received it. If you send it again and it did arrive the first time, you may have created two of whatever it was: two candidates, two bookings, two occupational health requests. Idempotency keys solve this. You attach a unique key to the request, and if the same request arrives again with the same key, the API returns the original answer instead of doing the work twice.

## The `Idempotency-Key` header

Send the header with a value you choose, up to 255 characters:

```
Idempotency-Key: 6f1d2f0e-6a77-4e43-a0c6-2a4c3f9b0b11
```

The API remembers the answer to the first request for **24 hours**. During that time:

- If the **same key** arrives again with the **same request content**, the API does not repeat the work. It returns the stored answer, with the same status code and body as the first time, and adds the response header `Idempotent-Replayed: true`. That header is how you tell a replay from a first answer.
- If the **same key** arrives with **different content**, the API refuses it with `409 idempotency_conflict`, because the key was already used for something else.
- If the key is **new**, the request runs normally.

A conflict looks like this:

```json
{
  "error": "idempotency_conflict",
  "message": "This Idempotency-Key was already used with a different request body.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

The header is optional. Without it the request runs as it always does, and a repeat does the work again. A key longer than 255 characters is refused with `422 validation_failed`, and a header that is empty or only spaces is ignored.

### What counts as the same request

The API stores a fingerprint of the request: a hash of its fields (the body fields first, then any query parameters that are not also in the body) and of each uploaded file by its name, size and content. Several details follow from that:

- A stored answer is looked up by your API key, the HTTP method, the **path** and the value you send, together. The same value used on two different endpoints does not clash, and two different API keys can use the same value without affecting each other. The fingerprint is compared only after that lookup finds a stored answer.
- The body must match exactly. The fingerprint is made from the fields in the order they arrive: the top-level fields of the JSON body in the order they were written (and, inside an object or list, in its order, and list items in order), then the query parameters. If your code builds the JSON in a different field order on the retry, the fingerprint differs and the API answers `409 idempotency_conflict`, even though the data is the same. Whitespace between fields does not matter, because the body is parsed first. The simplest safe approach is to serialise the body once, store it, and resend those exact bytes.
- A retry with a corrected body needs a new key. See "Only successes are stored" below.

### Only successes are stored

The API stores only successful answers: `2xx` responses. An answer that was an error is not stored, so repeating the same key after a `4xx` or `5xx` runs the request again. That is useful: if a request fails validation, you can correct it and resend it under the same key, because the failed attempt left no record. It also means a `5xx` needs care, which the retry strategy below covers.

If a retry arrives while your first request is still being processed, the API makes the second one wait until the first has finished (for a few seconds) and then answers it with the stored result. If the first is still running after that wait, the retry can fail with a `5xx`. Wait a little and send it again.

Replays count against your hourly [rate limit](09-rate-limits.md) like any other call.

## Which endpoints support it

Only the endpoints that create something, or start something that must not happen twice, check the header. If you send it to any other endpoint it is ignored. The full list is:

| Portal | Endpoints |
| --- | --- |
| Hub core | `POST /hub/candidates` |
| Online Training | `POST /online-training/candidates/{candidate_ref}/emails` |
| Occupational Health | `POST /occupational-health/requests` |
| Practical Training | `POST /practical-training/training-events/{event}/hold`, `POST /practical-training/bookings`, `POST /practical-training/booking-invites` |
| Virtual BLS Training | `POST /virtual-bls-training/timeslots/hold`, `POST /virtual-bls-training/bookings` |
| Clinical Interviews | `POST /clinical-interviews/timeslots/hold`, `POST /clinical-interviews/bookings`, `POST /clinical-interviews/bookings/{id}/reschedule` |
| Clinical Appraisals | `POST /clinical-appraisals/bookings` |
| References | `POST /references/requests`, `POST /references/requests/{uuid}/referees` |
| Training Verification | `POST /training-verification/verifications` (the Hub form's `submission_token`; a late retry after the 24 hours still finds the same verification and never charges twice) |
| Registration Monitoring | `POST /registration-monitoring/workers`, `POST /registration-monitoring/workers/{worker}/verify`, `POST /registration-monitoring/verify/batch`, `POST /registration-monitoring/worker-imports` |
| DBS and Right To Work | `POST /dbs-rtw/workers`, `POST /dbs-rtw/workers/{worker}/verify`, `POST /dbs-rtw/verify/batch`, `POST /dbs-rtw/worker-imports` |

Other writes are not covered by the header. Some are safe to repeat for another reason. For example `PUT /online-training/candidates/{candidate_ref}/courses` sets an exact list of courses, so sending it twice changes nothing the second time. Think about each other write yourself before you retry it, using the portal's page as a guide.

Occupational Health has one extra safeguard. If you repeat a request after the 24-hour store no longer holds it, the API may still recognise it as a duplicate and answer `200` with `"duplicate": true`, rather than `201`. The [Occupational Health page](../portals/occupational-health.md) explains it.

## Generating keys

A key only has to be unique for each distinct operation. Two approaches work well.

- **A random UUID, stored with the operation.** Generate a version 4 UUID when you decide to make the call, save it together with the body, and use it for every attempt. This is the simplest approach and is right for most uses. The important part is to save the key before you send the first attempt. If your process dies and restarts, it must reuse the same key, not make a new one.
- **A key derived from your own data.** Build the key from something that identifies the operation in your system, for example `create-candidate-STAFF-0042` or `booking-invite-{your-booking-id}`. This survives restarts without storing anything. Make sure the derived value is genuinely unique to the operation and does not repeat for a legitimately different one, because the same key with a different body is refused for 24 hours.

Do not use a timestamp or a counter that restarts, and do not use a key that is too predictable. Do not put personal data in keys, because keys can appear in your logs. A UUID is a good default.

## A safe retry strategy

A retry is safe when you send the same key and the same body. Decide what to retry by the outcome:

| Outcome | What to do |
| --- | --- |
| Network error, timeout, dropped connection | Retry with the same key and body. You do not know whether it arrived |
| `200` or `201` | Done. If `Idempotent-Replayed: true` is present, it was a repeat of an earlier success |
| `409 idempotency_conflict` | Do not retry. A different request used this key. Find the bug |
| `422`, `400`, `404`, `403`, `401` | Do not retry as is. Correct the request. After a `401 invalid_token`, renew your token and retry once (see [authentication](02-authentication.md)) |
| `429` | Wait for `Retry-After` seconds and retry with the same key |
| `500`, `502`, `503`, `504` | Retry with the same key after a growing pause, a limited number of times |

The reason for waiting before retrying a `5xx` is the point about stored answers made above: a `5xx` is not stored. If the first attempt did its work and then failed on the way out, the retry runs the request again. The portals protect themselves against many duplicates (for example, a booking for a place that is already taken is refused), but if you cannot afford a duplicate, check the state with a `GET` before you retry. Use a pause that doubles each time, with a little random jitter, and give up after a handful of attempts so that you do not hammer a struggling service. [Errors](08-errors.md) lists the status codes.

The samples below create a Hub candidate with this strategy. They generate the key once, send the same body each time, wait for `Retry-After` on a `429` and back off on `5xx` and network errors, and report whether the answer was a replay.

### cURL

The shell version retries on the exit status of curl and on `5xx` and `429` answers. It needs `jq` and `uuidgen`.

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

KEY=$(uuidgen)
BODY='{"first_name":"Ann","last_name":"Lee","email":"ann.lee@example.com","roles":["Registered Nurse"]}'

for ATTEMPT in 1 2 3 4 5; do
  STATUS=$(curl --silent --output response.json --dump-header headers.txt --write-out '%{http_code}' \
    "$BASE/hub/candidates" \
    --request POST \
    --header "Authorization: Bearer $ACCESS_TOKEN" \
    --header "Idempotency-Key: $KEY" \
    --header 'Content-Type: application/json' \
    --header 'Accept: application/json' \
    --data "$BODY") || STATUS=000

  case "$STATUS" in
    200|201)
      if grep -qi '^idempotent-replayed: true' headers.txt; then echo 'Replayed answer'; else echo 'First answer'; fi
      jq . response.json
      exit 0 ;;
    429)
      WAIT=$(grep -i '^retry-after:' headers.txt | tr -dc '0-9')
      sleep "${WAIT:-5}" ;;
    000|500|502|503|504)
      sleep $((2 ** ATTEMPT)) ;;
    *)
      echo "Not retrying: HTTP $STATUS"; jq . response.json; exit 1 ;;
  esac
done

echo 'Gave up after 5 attempts' >&2
exit 1
```

### JavaScript

```javascript
import { randomUUID } from 'node:crypto';

const BASE = 'https://hub.hbcompliance.co.uk/api/v2';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function exchangeKey() {
  const response = await fetch(`${BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ api_key: process.env.HB_API_KEY }),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }
  return (await response.json()).access_token;
}

/** POST a body with one idempotency key, retrying only when it is safe to. */
async function postIdempotent(token, path, bodyText, key, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;

    try {
      response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: bodyText,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      await sleep(2 ** attempt * 500 + Math.random() * 250);
      continue;
    }

    const body = await response.json().catch(() => null);

    if (response.status === 200 || response.status === 201) {
      return { body, replayed: response.headers.get('idempotent-replayed') === 'true' };
    }

    if (response.status === 429) {
      await sleep(Number(response.headers.get('retry-after') ?? 5) * 1000);
      continue;
    }

    if ([500, 502, 503, 504].includes(response.status)) {
      await sleep(2 ** attempt * 500 + Math.random() * 250);
      continue;
    }

    throw new Error(`Not retrying: ${response.status} ${body?.error} (request ${body?.request_id})`);
  }

  throw new Error(`Gave up after ${maxAttempts} attempts`);
}

const token = await exchangeKey();
const key = randomUUID();
const bodyText = JSON.stringify({
  first_name: 'Ann',
  last_name: 'Lee',
  email: 'ann.lee@example.com',
  roles: ['Registered Nurse'],
});

const result = await postIdempotent(token, '/hub/candidates', bodyText, key);
console.log(result.replayed ? 'Replayed answer' : 'First answer', result.body.data.candidate_ref);

const again = await postIdempotent(token, '/hub/candidates', bodyText, key);
console.log('Second call replayed:', again.replayed);
```

### PHP

```php
<?php

const HB_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

/** @return array{0: int, 1: array<string, string>, 2: mixed} */
function hb_call(string $method, string $path, ?string $token, ?string $bodyText = null, array $extraHeaders = []): array
{
    $responseHeaders = [];
    $headers = ['Accept: application/json', ...$extraHeaders];

    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    if ($bodyText !== null) {
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

    if ($bodyText !== null) {
        curl_setopt($curl, CURLOPT_POSTFIELDS, $bodyText);
    }

    $raw = curl_exec($curl);

    if ($raw === false) {
        $message = curl_error($curl);
        curl_close($curl);
        throw new RuntimeException($message);
    }

    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);

    return [$status, $responseHeaders, json_decode($raw, true)];
}

function uuid_v4(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
}

/** POST a body with one idempotency key, retrying only when it is safe to. */
function post_idempotent(string $token, string $path, string $bodyText, string $key, int $maxAttempts = 5): array
{
    for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
        try {
            [$status, $headers, $body] = hb_call('POST', $path, $token, $bodyText, ["Idempotency-Key: {$key}"]);
        } catch (RuntimeException) {
            usleep((2 ** $attempt) * 500_000 + random_int(0, 250_000));
            continue;
        }

        if ($status === 200 || $status === 201) {
            return ['body' => $body, 'replayed' => ($headers['idempotent-replayed'] ?? '') === 'true'];
        }

        if ($status === 429) {
            sleep((int) ($headers['retry-after'] ?? 5));
            continue;
        }

        if (in_array($status, [500, 502, 503, 504], true)) {
            usleep((2 ** $attempt) * 500_000 + random_int(0, 250_000));
            continue;
        }

        throw new RuntimeException("Not retrying: {$status} {$body['error']} (request {$body['request_id']})");
    }

    throw new RuntimeException("Gave up after {$maxAttempts} attempts");
}

[$status, , $tokenAnswer] = hb_call('POST', '/auth/token', null, json_encode(['api_key' => (string) getenv('HB_API_KEY')]));

if ($status !== 200) {
    exit("Token exchange failed: {$tokenAnswer['error']}\n");
}

$key = uuid_v4();
$bodyText = json_encode([
    'first_name' => 'Ann',
    'last_name' => 'Lee',
    'email' => 'ann.lee@example.com',
    'roles' => ['Registered Nurse'],
]);

$result = post_idempotent($tokenAnswer['access_token'], '/hub/candidates', $bodyText, $key);
echo $result['replayed'] ? 'Replayed answer' : 'First answer', ' ', $result['body']['data']['candidate_ref'], "\n";

$again = post_idempotent($tokenAnswer['access_token'], '/hub/candidates', $bodyText, $key);
echo 'Second call replayed: ', $again['replayed'] ? 'true' : 'false', "\n";
```

### Python

```python
import json
import os
import random
import time
import uuid

import requests

BASE = "https://hub.hbcompliance.co.uk/api/v2"


def exchange_key():
    response = requests.post(
        f"{BASE}/auth/token",
        json={"api_key": os.environ["HB_API_KEY"]},
        headers={"Accept": "application/json"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def post_idempotent(token, path, body_text, key, max_attempts=5):
    """POST a body with one idempotency key, retrying only when it is safe to."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Idempotency-Key": key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    for attempt in range(1, max_attempts + 1):
        try:
            response = requests.post(f"{BASE}{path}", data=body_text, headers=headers, timeout=30)
        except (requests.ConnectionError, requests.Timeout):
            time.sleep(2**attempt * 0.5 + random.random() * 0.25)
            continue

        if response.status_code in (200, 201):
            replayed = response.headers.get("Idempotent-Replayed") == "true"
            return response.json(), replayed

        if response.status_code == 429:
            time.sleep(int(response.headers.get("Retry-After", 5)))
            continue

        if response.status_code in (500, 502, 503, 504):
            time.sleep(2**attempt * 0.5 + random.random() * 0.25)
            continue

        body = response.json()
        raise RuntimeError(f"Not retrying: {response.status_code} {body.get('error')} (request {body.get('request_id')})")

    raise RuntimeError(f"Gave up after {max_attempts} attempts")


token = exchange_key()
key = str(uuid.uuid4())
body_text = json.dumps(
    {"first_name": "Ann", "last_name": "Lee", "email": "ann.lee@example.com", "roles": ["Registered Nurse"]}
)

body, replayed = post_idempotent(token, "/hub/candidates", body_text, key)
print("Replayed answer" if replayed else "First answer", body["data"]["candidate_ref"])

_, again_replayed = post_idempotent(token, "/hub/candidates", body_text, key)
print("Second call replayed:", again_replayed)
```

The second call in each sample reuses the key and body, so it comes back as a replay with `Idempotent-Replayed: true`, and no second candidate is created. The replayed body is identical to the first:

```json
{
  "data": {
    "candidate_ref": "78572976-3a12-417c-9a26-f88938703800",
    "first_name": "Ann",
    "last_name": "Lee",
    "name": "Ann Lee",
    "email": "ann.lee@example.com",
    "phone": null,
    "roles": ["Registered Nurse"],
    "specialties": [],
    "candidate_reference": null,
    "compliance_officer": null,
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

The fields are explained in [candidates and candidate_ref](03-candidates-and-candidate-ref.md). If you run the samples a second time with a new key, the API refuses the creation with `422` because the email already exists, which is the correct outcome.
