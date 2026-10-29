# Getting started

This guide takes you from nothing to a working call against the Healthier Business Hub API. By the end you will have created an API key, exchanged it for a token, listed your candidates and understood the shape of what came back. The later guides build on this one, so it is worth reading to the end even if you have used similar APIs before.

## What the API is

The Hub API is a JSON API over HTTPS. You send a request with a method, a path and, for writes, a JSON body, and you receive a JSON response and a status code. Every path lives under one base URL:

```
https://hub.hbcompliance.co.uk/api/v2
```

The `v2` in the path is the version. Every example in these guides builds its URLs from that base. Only HTTPS is supported, and every answer is JSON, including errors, so you can always parse the body.

One API covers every portal your organisation uses with Healthier Business. A call to Online Training, Occupational Health, Practical Training, Virtual BLS Training, Clinical Interviews, Clinical Appraisals, References, Registration Monitoring or DBS and Right To Work uses the same base URL, the same way of signing in, the same list format and the same error format. There is also a small core API for the Hub itself, which holds your candidates. You will meet it in a moment.

## The Hub model

Three ideas explain most of how the API fits together.

**One client account, many portals.** Your organisation is one client in the Hub. Each portal you use is switched on for that client. A key belongs to the client, so it can reach any portal the client has, as far as its scopes allow. If you call a portal that your account does not use, the API answers `403` with the error code `portal_unavailable`. The Hub core API is the exception: every client with an API key has it.

**Scopes decide what a key may do.** When you create a key you choose its scopes, such as `hub:candidates:read` or `online-training:candidates:write`. A key can never do more than its scopes allow, whatever portals the account has. Guide [04, scopes and permissions](04-scopes-and-permissions.md) explains the format and lists every scope.

**One identity for each person: `candidate_ref`.** A candidate belongs to your organisation in the Hub, not to a portal. The Hub gives every candidate one uuid, called `candidate_ref`, and every portal API uses that same value to refer to the person. Integer candidate ids from the portals never appear in the v2 API. Guide [03, candidates and candidate_ref](03-candidates-and-candidate-ref.md) covers creating candidates and using the reference everywhere.

## Create an API key

You create keys in the Hub itself, on the Developer page (`/client/developer` on the Hub site). You need the Developer permission to see it. The Owner, Administrator and Compliance Manager roles have that permission by default, and there is also a dedicated Developer role for people who only manage keys and webhooks. Guide [13, going live](13-going-live.md) describes the role.

On the Developer page, open the **API keys** tab and choose **Create API key**. The form asks for four things:

- A **name**, up to 100 characters. It is only a label for you, so use something that says what the key is for, such as `Rota system, production`.
- The **scopes**. At least one is required, and none are selected for you. Choose the smallest set that does the job. For this guide, tick `hub:candidates:read` under Hub (core).
- An optional **list of allowed IP addresses**. Leave it empty for now. Guide [05, IP allowlisting](05-ip-allowlisting.md) explains when to set it.
- An optional **expiry date**, which must be in the future.

When you save, the Hub shows the key once, in a dialog. It looks like this:

```
hbk_kwXoIIXGvOoNZYW2mZp0zVZomHFwUbbYrEqmSM9wCZ7Uw9xf
```

Copy it into your password manager or secret store straight away and choose **I have stored it safely**. The Hub keeps only a one-way hash of the key. It cannot show the key again, and neither can we. The key list shows only the first eight characters (`hbk_kwXo`) so that you can tell keys apart. If you lose a key, regenerate it from the key's menu: that gives you a new secret and stops the old one working at once.

Treat the key like a password. Keep it on your server, in an environment variable or a secret store, and never put it in a web page, a mobile app or a source repository.

## Your first call

The API does not take the key on every request. Instead you exchange the key once for a short-lived access token, and send the token on each call. A token lasts 60 minutes. Guide [02, authentication](02-authentication.md) explains the exchange, refreshing and revoking in full. For a first call you need only two steps.

The first step is `POST /auth/token` with your key in a JSON body. The second is `GET /hub/candidates` with the access token in an `Authorization: Bearer` header.

The examples below read your key from an environment variable called `HB_API_KEY`, so set that first. In a shell on macOS or Linux:

```bash
export HB_API_KEY='hbk_kwXoIIXGvOoNZYW2mZp0zVZomHFwUbbYrEqmSM9wCZ7Uw9xf'
```

### cURL

The cURL example uses `jq` to pull the token out of the first answer. If you do not have `jq`, copy the `access_token` value by hand into the second command.

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

curl --silent --fail-with-body "$BASE/hub/candidates?per_page=5" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json'
```

### JavaScript

This uses the built-in `fetch` in Node 18 or later. Save it as `first-call.mjs` and run `node first-call.mjs`.

```javascript
const BASE = 'https://hub.hbcompliance.co.uk/api/v2';
const apiKey = process.env.HB_API_KEY;

if (!apiKey) {
  throw new Error('Set the HB_API_KEY environment variable first.');
}

const tokenResponse = await fetch(`${BASE}/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ api_key: apiKey }),
});

if (!tokenResponse.ok) {
  throw new Error(`Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
}

const { access_token: accessToken } = await tokenResponse.json();

const listResponse = await fetch(`${BASE}/hub/candidates?per_page=5`, {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
});

const list = await listResponse.json();

if (!listResponse.ok) {
  throw new Error(`${list.error}: ${list.message} (request ${list.request_id})`);
}

console.log(`Showing ${list.data.length} of ${list.meta.total} candidates`);
for (const candidate of list.data) {
  console.log(candidate.candidate_ref, candidate.name, candidate.compliance_status);
}
```

### PHP

This uses plain `curl_*` functions and no packages. Save it as `first-call.php` and run `php first-call.php`.

```php
<?php

const HB_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

function hb_call(string $method, string $path, ?string $token = null, ?array $json = null): array
{
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

$apiKey = getenv('HB_API_KEY');

if ($apiKey === false || $apiKey === '') {
    exit("Set the HB_API_KEY environment variable first.\n");
}

[$status, $token] = hb_call('POST', '/auth/token', null, ['api_key' => $apiKey]);

if ($status !== 200) {
    exit("Token exchange failed: {$token['error']} ({$token['message']})\n");
}

[$status, $list] = hb_call('GET', '/hub/candidates?per_page=5', $token['access_token']);

if ($status !== 200) {
    exit("{$list['error']}: {$list['message']} (request {$list['request_id']})\n");
}

echo "Showing " . count($list['data']) . " of {$list['meta']['total']} candidates\n";

foreach ($list['data'] as $candidate) {
    echo "{$candidate['candidate_ref']} {$candidate['name']} {$candidate['compliance_status']}\n";
}
```

### Python

This uses the `requests` library (`pip install requests`). Save it as `first_call.py` and run `python3 first_call.py`.

```python
import os
import sys

import requests

BASE = "https://hub.hbcompliance.co.uk/api/v2"
api_key = os.environ.get("HB_API_KEY")

if not api_key:
    sys.exit("Set the HB_API_KEY environment variable first.")

token_response = requests.post(
    f"{BASE}/auth/token",
    json={"api_key": api_key},
    headers={"Accept": "application/json"},
    timeout=30,
)

if token_response.status_code != 200:
    sys.exit(f"Token exchange failed: {token_response.status_code} {token_response.text}")

access_token = token_response.json()["access_token"]

list_response = requests.get(
    f"{BASE}/hub/candidates",
    params={"per_page": 5},
    headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    timeout=30,
)
body = list_response.json()

if list_response.status_code != 200:
    sys.exit(f"{body['error']}: {body['message']} (request {body['request_id']})")

print(f"Showing {len(body['data'])} of {body['meta']['total']} candidates")
for candidate in body["data"]:
    print(candidate["candidate_ref"], candidate["name"], candidate["compliance_status"])
```

## Reading the responses

The token exchange answers `200` with this body. The values are shortened examples of the real shape: tokens are 80 characters long.

```json
{
  "token_type": "Bearer",
  "access_token": "u8jzPde0IgxLd6GncfBAepfJBd0Kh8oOOL8dKLzdocJ2isAjIhKtJ0RlgLKOmxgJTeKdNnFRIBXuDL7D",
  "refresh_token": "xtpYlSXpfKtHF4vUCsMehGAkWvj7FAc9QeWJKY40uvSwMFLZDe1f8rESQedUStPKR0CsTy4Qwb8DwkNh",
  "expires_in": 3600,
  "refresh_expires_in": 604800
}
```

`expires_in` and `refresh_expires_in` are in seconds: one hour for the access token and seven days for the refresh token.

The candidate list answers `200` with the list envelope that every list endpoint in the API uses. This example is for a client with two candidates:

```json
{
  "data": [
    {
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
      "compliance_status": "compliant",
      "next_expiry_date": "2027-08-24",
      "added_at": "2026-10-01T09:30:00Z",
      "updated_at": "2026-10-28T19:53:24Z"
    },
    {
      "candidate_ref": "7b8f2ab5-3451-4013-9675-f6ad325b55dd",
      "first_name": "Ben",
      "last_name": "Okafor",
      "name": "Ben Okafor",
      "email": "ben.okafor@example.com",
      "phone": "07700 900123",
      "roles": ["Healthcare Assistant"],
      "specialties": ["Theatre"],
      "candidate_reference": "STAFF-0042",
      "compliance_officer": "Sam Patel",
      "is_active": true,
      "compliance_status": "expiring_soon",
      "next_expiry_date": "2026-12-01",
      "added_at": "2026-09-12T14:05:00Z",
      "updated_at": "2026-10-20T08:15:42Z"
    }
  ],
  "meta": { "page": 1, "per_page": 5, "total": 2, "last_page": 1, "from": 1, "to": 2 },
  "links": {
    "first": "https://hub.hbcompliance.co.uk/api/v2/hub/candidates?per_page=5&page=1",
    "last": "https://hub.hbcompliance.co.uk/api/v2/hub/candidates?per_page=5&page=1",
    "prev": null,
    "next": null
  }
}
```

Here is how to read it.

- **`data`** holds the records. For a single record, such as `GET /hub/candidates/{candidate_ref}`, `data` is one object instead of an array. For a list it is always an array, even when it is empty.
- **`meta`** describes the page you got: which page it is, how many records a page holds, the total across all pages and the number of the last page. `from` and `to` are the 1-based positions of the first and last row on this page, and are `null` for an empty page.
- **`links`** are absolute URLs for the first, last, previous and next pages. They keep every filter and sort you sent, so you can follow `links.next` until it is `null`. Guide [06, pagination, filtering and sorting](06-pagination-filtering-sorting.md) covers lists in detail.
- **Dates and times** that include a time are ISO 8601 in UTC with a trailing `Z`, such as `2026-10-28T19:53:24Z`. A date without a time, such as `next_expiry_date`, is `YYYY-MM-DD`.
- **`candidate_ref`** is the uuid you will use everywhere else.
- **Money**, where it appears in other portals, is an integer number of pence with a `currency` field, never a decimal number of pounds.

An empty account is not an error: you receive `"data": []` and a `meta.total` of `0`.

## If something goes wrong

Every error has the same body, whatever went wrong:

```json
{
  "error": "insufficient_scope",
  "message": "The API key lacks the [hub:candidates:read] scope.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

The `error` code is stable and meant for your code to read. The `message` is for people and may change wording, so do not parse it. The `request_id` is also sent in the `X-Request-Id` response header. Quote it if you contact support. The commonest problems on a first call are these:

- `401 invalid_credentials` on the token exchange means the key is wrong, was regenerated or was deleted. Check you copied the whole key.
- `403 key_inactive` means the key is switched off or has passed its expiry date.
- `403 ip_not_allowed` means the key has an IP allowlist and your address is not on it.
- `403 insufficient_scope` means the key lacks the scope the endpoint needs. The message names it. Edit the key on the Developer page to add it.
- `422 validation_failed` on the token exchange means the `api_key` field was missing from the body.

Guide [08, errors](08-errors.md) lists every code.

## Where to go next

Read [02, authentication](02-authentication.md) before you write real code: it shows how to keep a token fresh without asking for a new one on every call. Then read [03, candidates and candidate_ref](03-candidates-and-candidate-ref.md) to create candidates and use them in the portal APIs. When you are ready to react to events instead of polling, read [10, webhooks](10-webhooks.md). The per-portal reference pages in [the portals folder](../portals/) describe every endpoint of each portal.
