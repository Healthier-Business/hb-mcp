# Scopes and permissions

A scope is a permission attached to an API key. Every endpoint needs one specific scope, and a key can call the endpoint only if it holds that scope. Scopes are how you make sure an integration can do its job and nothing else, so that a leaked key or a coding mistake does limited harm.

## The scope format

A scope has three parts, separated by colons:

```
{portal}:{resource}:{access}
```

- The **portal** is the key of a portal: `hub`, `online-training`, `occupational-health`, `practical-training`, `virtual-bls-training`, `clinical-interviews`, `clinical-appraisals`, `references`, `registration-monitoring` or `dbs-rtw`. Webhook management uses the pseudo-portal `account`.
- The **resource** is a group of endpoints inside the portal, such as `candidates`, `bookings`, `credits` or `documents`.
- The **access** is `read` or `write`. Read covers calls that only look at data. Write covers calls that create, change or delete something, or that cause something to happen, such as sending an email.

So `online-training:candidates:read` lets a key list and read Online Training candidates, and `online-training:candidates:write` lets it assign courses to them.

There are two wildcards:

- **`{portal}:*`** covers everything in one portal, for example `occupational-health:*`.
- **`*`** covers everything, in every portal, including webhook management.

The wildcards are convenient for a quick experiment and a poor choice for production. A key with `*` can do everything your account can do through the API, including anything we add later.

## Write implies read

A `:write` scope also grants the matching `:read` scope. A key with `online-training:candidates:write` may therefore also call `GET /online-training/candidates`, which needs `online-training:candidates:read`, so you do not have to tick both.

The rule is narrow. It never works in the other direction: `:read` does not give `:write`. And it never crosses to a different resource or portal: `online-training:candidates:write` does not give `online-training:results:read`, because that is another resource.

A few resources have only one kind of access. For example `practical-training:holds` has only a write scope, and `online-training:emails` has only a write scope, because there is nothing to read.

## Every scope

The tables below list every scope a key can be given, by portal. They come from the API's configuration. Each portal's page in [the portals folder](../portals/) maps scopes to individual endpoints, and the machine-readable specification (`hub-v2.json`, see [SDKs and tools](15-sdk-and-tools.md)) names the scope each operation needs in `x-required-scope`.

### Account (webhook management)

Whole portal: `account:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `account:webhooks:read` | `account:webhooks:write` | Webhook endpoints and deliveries |

### Hub (core)

Whole portal: `hub:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `hub:candidates:read` | `hub:candidates:write` | Candidates: list, read, create and edit (the candidate_ref every portal API uses) |

### Practical Training

Whole portal: `practical-training:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `practical-training:account:read` | none | Profile and booking link |
| `practical-training:credits:read` | none | Booking credits, booking balance and transactions |
| `practical-training:catalogue:read` | none | Courses, locations and training events |
| none | `practical-training:holds:write` | Hold and release a place on a training event |
| `practical-training:bookings:read` | `practical-training:bookings:write` | Bookings, certificates and booking invitations |

### Registration Monitoring

Whole portal: `registration-monitoring:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `registration-monitoring:workers:read` | `registration-monitoring:workers:write` | Monitored registrations and their monitoring settings |
| `registration-monitoring:evidence:read` | none | Evidence files of registration checks |
| `registration-monitoring:verification:read` | `registration-monitoring:verification:write` | Re-check now, check history and job progress |
| `registration-monitoring:alerts:read` | `registration-monitoring:alerts:write` | Registration alerts |
| `registration-monitoring:imports:read` | `registration-monitoring:imports:write` | CSV worker imports |
| `registration-monitoring:billing:read` | none | Monitoring subscription, bills and invoices |
| `registration-monitoring:team:read` | none | The roles and permissions a team member can hold |

### DBS & Right To Work

Whole portal: `dbs-rtw:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `dbs-rtw:workers:read` | `dbs-rtw:workers:write` | DBS and right to work workers, monitoring settings and share codes |
| `dbs-rtw:evidence:read` | none | DBS certificates, right to work screenshots and uploaded documents |
| `dbs-rtw:verification:read` | `dbs-rtw:verification:write` | Re-check now, check history and job progress |
| `dbs-rtw:alerts:read` | `dbs-rtw:alerts:write` | DBS and right to work alerts |
| `dbs-rtw:imports:read` | `dbs-rtw:imports:write` | CSV worker imports |
| `dbs-rtw:billing:read` | none | Monitoring subscription, bills and invoices |
| `dbs-rtw:team:read` | none | The roles and permissions a team member can hold |

### Online Training

Whole portal: `online-training:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `online-training:account:read` | none | Profile and dashboard numbers |
| `online-training:credits:read` | none | Credit balance, transactions and top-up packages |
| `online-training:courses:read` | none | Courses the account can assign |
| `online-training:candidates:read` | `online-training:candidates:write` | Candidates with training (by candidate_ref), their courses and assigning training |
| `online-training:results:read` | none | A candidate's modules, course results and practical training results |
| `online-training:certificates:read` | none | Candidate training certificates |
| none | `online-training:emails:write` | Reminder emails to candidates |

### Occupational Health

Whole portal: `occupational-health:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `occupational-health:account:read` | none | Profile, settings and notification emails |
| `occupational-health:catalogue:read` | none | Clearance types, request options, upload limits and questionnaires |
| `occupational-health:candidates:read` | `occupational-health:candidates:write` | Candidates, their request history and reminders |
| `occupational-health:requests:read` | `occupational-health:requests:write` | Requests, their answers, and creating a request |
| `occupational-health:documents:read` | none | Request documents and Fit to Work certificates |
| `occupational-health:alerts:read` | `occupational-health:alerts:write` | Rejected and not fit alerts |
| `occupational-health:reports:read` | `occupational-health:reports:write` | Generate and download reports |
| `occupational-health:credits:read` | none | Credit balance, transactions and top-up packages |

### References

Whole portal: `references:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `references:requests:read` | `references:requests:write` | Reference requests, their referees and reminders |
| `references:referees:read` | none | A referee's reference, its answers and PDF |
| `references:templates:read` | none | Reference form templates |

### Virtual BLS Training

Whole portal: `virtual-bls-training:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `virtual-bls-training:account:read` | none | Profile and booking link |
| `virtual-bls-training:credits:read` | none | Booking credits, booking balance and transactions |
| `virtual-bls-training:catalogue:read` | none | Courses and free timeslots |
| none | `virtual-bls-training:holds:write` | Hold and release a timeslot |
| `virtual-bls-training:bookings:read` | `virtual-bls-training:bookings:write` | Bookings and certificates |

### Clinical Interviews

Whole portal: `clinical-interviews:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `clinical-interviews:account:read` | none | Profile |
| `clinical-interviews:credits:read` | none | Credit and money balances and transactions |
| `clinical-interviews:catalogue:read` | none | Interview types and free timeslots |
| none | `clinical-interviews:holds:write` | Hold and release a timeslot |
| `clinical-interviews:bookings:read` | `clinical-interviews:bookings:write` | Interviews and interview reports |

### Clinical Appraisals

Whole portal: `clinical-appraisals:*`.

| Read scope | Write scope | What it covers |
| --- | --- | --- |
| `clinical-appraisals:account:read` | none | Profile |
| `clinical-appraisals:credits:read` | none | Credit and money balances and transactions |
| `clinical-appraisals:catalogue:read` | none | Appraisal types |
| `clinical-appraisals:bookings:read` | `clinical-appraisals:bookings:write` | Appraisals and evaluation reports |

## Choosing the least privilege

Start from the calls your integration makes and give it exactly the scopes those calls need. A few examples show how this works out.

- **A dashboard that shows compliance.** It lists candidates and reads training results. Give it `hub:candidates:read` and `online-training:results:read`, perhaps with `online-training:candidates:read`. It cannot change anything, even by mistake.
- **An HR or rota system that adds starters and assigns their training.** It creates candidates and assigns courses. Give it `hub:candidates:write` and `online-training:candidates:write`, plus `online-training:courses:read` to list the courses it may assign. Because write implies read, it can still list candidates.
- **A booking integration for practical training.** It reads the catalogue, holds a place, books it and reads bookings. Give it `practical-training:catalogue:read`, `practical-training:holds:write` and `practical-training:bookings:write`.
- **A service that only receives webhooks.** It needs no API scopes for receiving, because Hub calls you. If it also registers its own endpoints, give it `account:webhooks:write` and nothing else.
- **A support tool that reads occupational health results.** Think carefully before granting `occupational-health:requests:read` or `occupational-health:documents:read`: they open health data. See [health data and privacy](11-health-data-and-privacy.md).

Some further habits help:

- **Use one key per integration.** If a key is compromised you can switch it off without disturbing the others, and the key list shows which integration used which key.
- **Separate read and write keys** for the same system if different parts of it have different needs.
- **Review keys now and then.** Scopes a key no longer needs are risk with no benefit. Edit the key on the Developer page to remove them. The change applies on the key's very next call, including for tokens you already hold, because the API checks the key's current scopes on every request.
- **Do not use `*` in production.**

## Checking what a token can do

`GET /auth/me` returns the scopes of the key behind the token, so you can check them at start-up and fail early with a clear message instead of discovering a missing scope in the middle of a job. It needs a bearer token but no scope.

The samples below read your scopes with `/auth/me` and then test a list of scopes against them. The test copies the API's own rule: `*` covers all, the exact scope covers itself, a `:write` scope covers its `:read`, and `{portal}:*` covers its portal.

### cURL

This lists the scopes of a key. Testing them is easier in a language with real logic, so see the other languages for that.

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

curl --silent --fail-with-body "$BASE/auth/me" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json' | jq '.key.scopes'
```

### JavaScript

```javascript
const BASE = 'https://hub.hbcompliance.co.uk/api/v2';

function covers(granted, needed) {
  if (granted.includes('*') || granted.includes(needed)) {
    return true;
  }
  if (needed.endsWith(':read') && granted.includes(`${needed.slice(0, -':read'.length)}:write`)) {
    return true;
  }
  return granted.includes(`${needed.split(':')[0]}:*`);
}

const tokenResponse = await fetch(`${BASE}/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ api_key: process.env.HB_API_KEY }),
});
const { access_token: accessToken } = await tokenResponse.json();

const meResponse = await fetch(`${BASE}/auth/me`, {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
});
const me = await meResponse.json();

const needed = ['hub:candidates:write', 'online-training:candidates:read', 'online-training:courses:read'];
const missing = needed.filter((scope) => !covers(me.key.scopes, scope));

if (missing.length > 0) {
  console.error(`The key "${me.key.name}" lacks: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('All needed scopes are present.');
```

### PHP

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

/** @param list<string> $granted */
function covers(array $granted, string $needed): bool
{
    if (in_array('*', $granted, true) || in_array($needed, $granted, true)) {
        return true;
    }

    if (str_ends_with($needed, ':read') && in_array(substr($needed, 0, -strlen(':read')) . ':write', $granted, true)) {
        return true;
    }

    return in_array(explode(':', $needed)[0] . ':*', $granted, true);
}

[, $token] = hb_call('POST', '/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')]);
[, $me] = hb_call('GET', '/auth/me', $token['access_token']);

$needed = ['hub:candidates:write', 'online-training:candidates:read', 'online-training:courses:read'];
$missing = array_values(array_filter($needed, fn (string $scope): bool => ! covers($me['key']['scopes'], $scope)));

if ($missing !== []) {
    fwrite(STDERR, "The key \"{$me['key']['name']}\" lacks: " . implode(', ', $missing) . "\n");
    exit(1);
}

echo "All needed scopes are present.\n";
```

### Python

```python
import os
import sys

import requests

BASE = "https://hub.hbcompliance.co.uk/api/v2"


def covers(granted, needed):
    if "*" in granted or needed in granted:
        return True
    if needed.endswith(":read") and needed[: -len(":read")] + ":write" in granted:
        return True
    return needed.split(":")[0] + ":*" in granted


token = requests.post(
    f"{BASE}/auth/token",
    json={"api_key": os.environ["HB_API_KEY"]},
    headers={"Accept": "application/json"},
    timeout=30,
).json()

me = requests.get(
    f"{BASE}/auth/me",
    headers={"Authorization": f"Bearer {token['access_token']}", "Accept": "application/json"},
    timeout=30,
).json()

needed = ["hub:candidates:write", "online-training:candidates:read", "online-training:courses:read"]
missing = [scope for scope in needed if not covers(me["key"]["scopes"], scope)]

if missing:
    sys.exit(f"The key {me['key']['name']!r} lacks: {', '.join(missing)}")

print("All needed scopes are present.")
```

## `insufficient_scope`

When a call needs a scope the key lacks, the answer is `403` with the code `insufficient_scope`, and the message names the scope that is missing:

```json
{
  "error": "insufficient_scope",
  "message": "The API key lacks the [online-training:candidates:write] scope.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

Do not retry: the answer will not change until someone edits the key. Read the scope out of the message for your log (or, better, look it up on the endpoint's page), then ask whoever manages keys to add it. A call refused for a missing scope still counts towards the key's hourly rate limit, because the key was authenticated.

## `portal_unavailable`

A scope says what a key may do. Whether your account uses the portal at all is a separate question. If a call goes to a portal your organisation does not use, the answer is `403` with the code `portal_unavailable`:

```json
{
  "error": "portal_unavailable",
  "message": "This account does not use this portal.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

Adding a scope to the key does not fix this. The portal must be enabled for your account first. Enabling a portal does not change your existing keys: you still choose their scopes. The Hub core API (`/hub/...`) and webhook management (`/webhooks`) are open to every key that has the scope.

The portal check comes before the scope check, so a call to a portal your account does not use gets `portal_unavailable` even if the key also lacks the scope.

## Who can manage keys: the Developer role

Creating and editing keys is itself a permission. In the Hub it is called **Manage API keys and webhooks** (`developer.manage`). It opens the Developer page and lets a person create, edit, regenerate and delete keys and webhook endpoints.

By default the Owner, Administrator and Compliance Manager roles hold it. Compliance Officer and Viewer do not, although the Owner can grant it to those roles for your organisation.

There is also a dedicated **Developer** role in My Team, meant for the people who build your integrations. A Developer holds only the permission to manage keys and webhooks. They cannot see candidates, reports, your team, billing or the portals, and signing in takes them straight to the Developer page. An Owner or Administrator assigns it from My Team, either to an existing member or in an invitation. The Developer role is also what lets someone connect your account to the HB developer portal, described in [going live](13-going-live.md).

Because keys can reach your candidates' data, give the Developer role to as few people as you can, and remove it when someone no longer builds the integration. Removing the role takes away their access to the keys immediately. It does not by itself change any key, so if the person knew a key's secret, regenerate it.
