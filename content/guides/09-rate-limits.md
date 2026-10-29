# Rate limits

Rate limits protect the API for everyone and give you a predictable ceiling to design against. There are three kinds, and it helps to know which one you have hit. This guide describes each, the headers that tell you where you stand, what a `429` looks like, and how to stay well inside the limits.

## The three kinds of limit

| Limit | Applies to | Size | Counted by |
| --- | --- | --- | --- |
| The hourly limit of the key | Every call that carries a bearer token | 1,000 an hour by default | The API key (all of its tokens share one count) |
| The authentication throttle | `POST /auth/token` and `POST /auth/refresh` | 10 a minute | Your IP address, and for the token exchange also the key you send |
| Per-portal and per-action throttles | A few portals and actions | See below | See below |

## The hourly limit of the key

Each API key has an hourly limit. A new key allows 1,000 calls an hour. The limit belongs to the key, so it is shared by everything that uses that key: every token you have issued from it, every process and every server. Two workers using one key draw from the same allowance. The limit can be set from 10 to 100,000 calls an hour for a key, and the Developer page does not at present have a field for it, so if 1,000 an hour is not enough for a genuine need, ask Healthier Business to change it.

The counter works in windows of one hour. The first counted call starts a window, and the allowance is available again when the window ends. The `X-RateLimit-Reset` header tells you exactly when.

What counts:

- Every call that gets as far as being authenticated counts, including calls that then fail because the key lacks a scope, the portal is not enabled, the request is invalid or the record does not exist. Replays of an idempotent request count too.
- `GET /auth/me` and `POST /auth/revoke` count, since they carry a bearer token.
- Calls that are refused before the key is accepted do not count: a missing or invalid token, a key that is switched off and a disallowed IP address.
- A call that is refused with `429` does not itself use up any allowance.
- The token exchange and refresh are not part of the hourly count. They have their own throttle.

## The rate limit headers

Every answer to a call that reached the rate limiter carries three headers, successful answers and errors alike:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | The key's allowance for the hour |
| `X-RateLimit-Remaining` | How many more calls fit in the current window, after this one |
| `X-RateLimit-Reset` | The Unix timestamp, in seconds, at which the window ends and the allowance returns |

A typical successful answer includes:

```
HTTP/2 200
content-type: application/json
x-request-id: 01JAQ0Y8Z3N5W6V7B2K4M9D1XC
x-ratelimit-limit: 1000
x-ratelimit-remaining: 994
x-ratelimit-reset: 1793209404
```

Use `Remaining` to slow down before you hit the wall, and `Reset` to know how long until you can go full speed again. To turn `Reset` into a wait, subtract the current Unix time.

## What a 429 looks like

When you are over the hourly limit the answer is `429`, with the standard error body, a `Retry-After` header and the rate limit headers with `Remaining` at `0`:

```
HTTP/2 429
content-type: application/json
retry-after: 1340
x-request-id: 01JAQ0Y8Z3N5W6V7B2K4M9D1XC
x-ratelimit-limit: 1000
x-ratelimit-remaining: 0
x-ratelimit-reset: 1793209404
```

```json
{
  "error": "rate_limited",
  "message": "Too many requests.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

`Retry-After` is the number of seconds until you may try again. Wait that long. Retrying immediately only wastes time and, if you do it in a loop, hammers the service. After the wait, retry the same call. If it was a write, send the same `Idempotency-Key` so that nothing is done twice (see [idempotency](07-idempotency.md)).

Because an hour is a long wait, treat the hourly limit as something to plan for, not recover from. See the advice at the end.

## The authentication throttle

The token exchange and the refresh call allow 10 calls a minute. The limit is counted by your IP address, and for the exchange also by the key in the body. When you exceed it you get `429 rate_limited` with a `Retry-After`. You should rarely meet it, because a token lasts an hour and a refresh gives you a new one. If you do, you are probably exchanging the key on every call. Cache the token as shown in [authentication](02-authentication.md).

## Per-portal and per-action throttles

A few routes have their own per-minute throttle in addition to the hourly limit. When you exceed one, the answer is the same `429 rate_limited`, with `Retry-After`.

| Where | Limit | Counted by |
| --- | --- | --- |
| Practical Training, all endpoints | 120 a minute | The calling IP address |
| Virtual BLS Training, all endpoints | 120 a minute | The access token |
| Clinical Interviews, all endpoints | 120 a minute | The access token |
| Clinical Appraisals, all endpoints | 120 a minute | The access token |
| Occupational Health: `POST /candidates/{candidate_ref}/reminder` | 20 a minute | The key |
| Occupational Health: `POST /reports/{type}/generate` | 10 a minute | The key |

The Hub core API, Online Training, References, Registration Monitoring, DBS and Right To Work have no per-minute throttle beyond the hourly limit. The Clinical Interviews slot-hold endpoint additionally has abuse limits that can answer `429` with the codes `too_fast`, `client_limit` or `ip_limit`. They are not tied to your hourly allowance, and guard against slot-hoarding. See [errors](08-errors.md).

These per-minute limits are far above what a normal integration needs. Reaching one almost always means a loop or a retry storm.

## Staying inside the limits

The cheapest call is the one you do not make. These habits keep usage low.

- **Use `per_page=100` for bulk reads.** A list of 5,000 candidates takes 50 calls instead of 200. See [pagination](06-pagination-filtering-sorting.md).
- **Filter on the server.** Ask for only what you need with filters, such as `compliance_status=expired` or `updated_from=...`, and do not download everything to filter locally.
- **Sync incrementally.** Store the time of your last successful sync and ask for records changed since then with `updated_from`, rather than reading everything each time.
- **Prefer webhooks to polling.** If you poll a list every minute to notice changes, that is 1,440 calls a day for one list. A [webhook](10-webhooks.md) tells you when something happens at no cost to your hourly count.
- **Cache reference data.** Catalogues such as courses, locations, clearance types and interview types change rarely. Fetch them once and refresh them hourly or daily.
- **Use batch endpoints where they exist.** Registration Monitoring and DBS and Right To Work have `POST /verify/batch`, which queues many re-checks in one call, instead of one call per worker. Check each portal's page for similar endpoints.
- **Reuse one token.** Each exchange is a call against the throttle, and an unnecessary one.
- **Spread the load.** If you run a nightly job, spread its calls over the window rather than sending them all in a burst, and avoid starting many jobs on the same key at the same moment.
- **Watch `X-RateLimit-Remaining`.** Slow down when it gets low, instead of running into `429`.
- **Use one key per integration.** The hourly limit belongs to the key, so a busy batch job on its own key cannot starve your interactive integration.
- **Back off on `429` and `5xx`**, honouring `Retry-After`, rather than retrying in a tight loop.

## A rate-aware client

The samples below make a call, read the rate limit headers and print them, wait for `Retry-After` on a `429` (up to three times), and pause until the window resets if `Remaining` reaches zero and the wait is short. They use `GET /auth/me`, which needs no scope.

### cURL

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

curl --silent --dump-header - --output /dev/null "$BASE/auth/me" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json' | grep -i -E '^(HTTP/|x-ratelimit|retry-after)'
```

The output has the status line and the three `x-ratelimit-*` headers, for example `x-ratelimit-remaining: 994`.

### JavaScript

```javascript
const BASE = 'https://hub.hbcompliance.co.uk/api/v2';
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

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

/** GET with rate limit awareness. Returns { status, body, rate }. */
async function getWithRateLimit(token, path, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    const rate = {
      limit: Number(response.headers.get('x-ratelimit-limit')),
      remaining: Number(response.headers.get('x-ratelimit-remaining')),
      reset: Number(response.headers.get('x-ratelimit-reset')),
    };

    if (response.status === 429 && attempt < maxRetries) {
      const wait = Number(response.headers.get('retry-after') ?? 60);
      console.warn(`Rate limited: waiting ${wait}s`);
      await sleep(wait);
      continue;
    }

    if (rate.remaining === 0 && rate.reset > 0) {
      const wait = rate.reset - Math.floor(Date.now() / 1000);
      if (wait > 0 && wait <= 120) {
        console.warn(`Allowance used: pausing ${wait}s until the window resets`);
        await sleep(wait);
      }
    }

    return { status: response.status, body: await response.json().catch(() => null), rate };
  }
}

const token = await exchangeKey();
const result = await getWithRateLimit(token, '/auth/me');

console.log(result.status, result.rate);
console.log(`${result.rate.remaining} of ${result.rate.limit} calls left; the window resets at ${new Date(result.rate.reset * 1000).toISOString()}`);
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

/** GET with rate limit awareness. @return array{status: int, body: mixed, rate: array<string, int>} */
function get_with_rate_limit(string $token, string $path, int $maxRetries = 3): array
{
    for ($attempt = 0; $attempt <= $maxRetries; $attempt++) {
        [$status, $headers, $body] = hb_call('GET', $path, $token);

        $rate = [
            'limit' => (int) ($headers['x-ratelimit-limit'] ?? 0),
            'remaining' => (int) ($headers['x-ratelimit-remaining'] ?? 0),
            'reset' => (int) ($headers['x-ratelimit-reset'] ?? 0),
        ];

        if ($status === 429 && $attempt < $maxRetries) {
            $wait = (int) ($headers['retry-after'] ?? 60);
            fwrite(STDERR, "Rate limited: waiting {$wait}s\n");
            sleep($wait);
            continue;
        }

        if ($rate['remaining'] === 0 && $rate['reset'] > 0) {
            $wait = $rate['reset'] - time();

            if ($wait > 0 && $wait <= 120) {
                fwrite(STDERR, "Allowance used: pausing {$wait}s until the window resets\n");
                sleep($wait);
            }
        }

        return ['status' => $status, 'body' => $body, 'rate' => $rate];
    }

    throw new RuntimeException('Unreachable');
}

[$status, , $tokenAnswer] = hb_call('POST', '/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')]);

if ($status !== 200) {
    exit("Token exchange failed: {$tokenAnswer['error']}\n");
}

$result = get_with_rate_limit($tokenAnswer['access_token'], '/auth/me');

echo $result['status'], ' ', json_encode($result['rate']), "\n";
echo "{$result['rate']['remaining']} of {$result['rate']['limit']} calls left; the window resets at ", gmdate('c', $result['rate']['reset']), "\n";
```

### Python

```python
import os
import sys
import time
from datetime import datetime, timezone

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


def get_with_rate_limit(token, path, max_retries=3):
    """GET with rate limit awareness. Returns (response, rate)."""
    for attempt in range(max_retries + 1):
        response = requests.get(
            f"{BASE}{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=30,
        )

        rate = {
            "limit": int(response.headers.get("X-RateLimit-Limit", 0)),
            "remaining": int(response.headers.get("X-RateLimit-Remaining", 0)),
            "reset": int(response.headers.get("X-RateLimit-Reset", 0)),
        }

        if response.status_code == 429 and attempt < max_retries:
            wait = int(response.headers.get("Retry-After", 60))
            print(f"Rate limited: waiting {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue

        if rate["remaining"] == 0 and rate["reset"] > 0:
            wait = rate["reset"] - int(time.time())
            if 0 < wait <= 120:
                print(f"Allowance used: pausing {wait}s until the window resets", file=sys.stderr)
                time.sleep(wait)

        return response, rate


response, rate = get_with_rate_limit(exchange_key(), "/auth/me")
reset_at = datetime.fromtimestamp(rate["reset"], tz=timezone.utc).isoformat()

print(response.status_code, rate)
print(f"{rate['remaining']} of {rate['limit']} calls left; the window resets at {reset_at}")
```
