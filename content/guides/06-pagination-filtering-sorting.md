# Pagination, filtering and sorting

Every endpoint that returns a collection works the same way, in every portal. Once you have written code to read one list, you can read them all. This guide describes the list format, the query parameters you can use, the errors you can get, and how to walk through every page safely.

## The list envelope

A list answers `200` with three keys: `data`, `meta` and `links`.

```json
{
  "data": [
    {
      "candidate_ref": "78572976-3a12-417c-9a26-f88938703800",
      "name": "Ann Lee",
      "email": "ann.lee@example.com",
      "compliance_status": "expired",
      "updated_at": "2026-10-28T19:53:24Z"
    },
    {
      "candidate_ref": "7b8f2ab5-3451-4013-9675-f6ad325b55dd",
      "name": "Ben Okafor",
      "email": "ben.okafor@example.com",
      "compliance_status": "expired",
      "updated_at": "2026-10-27T08:15:42Z"
    }
  ],
  "meta": { "page": 1, "per_page": 2, "total": 5, "last_page": 3, "from": 1, "to": 2 },
  "links": {
    "first": "https://hub.hbcompliance.co.uk/api/v2/hub/candidates?compliance_status=expired&sort=-updated_at&per_page=2&page=1",
    "last": "https://hub.hbcompliance.co.uk/api/v2/hub/candidates?compliance_status=expired&sort=-updated_at&per_page=2&page=3",
    "prev": null,
    "next": "https://hub.hbcompliance.co.uk/api/v2/hub/candidates?compliance_status=expired&sort=-updated_at&per_page=2&page=2"
  }
}
```

The example shows two candidate fields per row to keep it short. Real rows have all the fields of the resource.

- **`data`** is always an array in a list, even if it is empty.
- **`meta.page`** is the page you asked for and **`meta.per_page`** is the page size in use.
- **`meta.total`** is the number of records that match your filters across all pages, and **`meta.last_page`** is the number of the last page. The last page is at least 1, even for an empty result.
- **`meta.from`** and **`meta.to`** are the 1-based positions of the first and last record on this page, so page 2 of 2 records per page has `from` 3 and `to` 4. Both are `null` when the page is empty.
- **`links`** hold absolute URLs for the first, last, previous and next page. `prev` is `null` on the first page and `next` is `null` on the last.

Short fixed lists, such as the courses of a portal or the interview types, use the same envelope. The whole list is one page, so `total` is its length, and they accept `page`, `per_page` and `sort` in the same way.

There are no cursors and no infinite lists: paging is by page number.

## `page` and `per_page`

| Parameter | Meaning | Rules |
| --- | --- | --- |
| `page` | The page to return | An integer of 1 or more, and at most 100,000,000. Default 1 |
| `per_page` | The number of records on a page | An integer from 1 to 100. Default 25 |

The API never quietly corrects a bad value. If `per_page` is 0, 500, negative or not a number, or `page` is below 1, the answer is `422 validation_failed` with the field named in `details`:

```json
{
  "error": "validation_failed",
  "message": "The per page field must not be greater than 100.",
  "details": { "per_page": ["The per page field must not be greater than 100."] },
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

The wording of `message` and of the strings inside `details` is written for people and may be changed, so read the field names in `details`, not the sentences. If you want the fewest calls, use `per_page=100`.

### A page beyond the end

Asking for a page after the last one is not an error. You get `200` with an empty `data`, the real `total` and `last_page`, and `from` and `to` set to `null`. `links.prev` points to the last real page. So your loop can safely stop when `data` is empty, although following `links.next` until it is `null` is cleaner and never asks for a page that does not exist.

## Sorting

Add `sort=field` for ascending order or `sort=-field` for descending, with a minus sign in front. You can sort by one field only, and only by the fields the endpoint lists. Each endpoint's page and the specification name them. For the Hub candidate list they are `name`, `email`, `added_at` and `updated_at`:

```
GET /api/v2/hub/candidates?sort=-updated_at
```

An unknown field answers `422 validation_failed` with the problem under `details.sort`, and the message lists the allowed fields. Some lists, such as short fixed ones, cannot be sorted and refuse any `sort` with the same error.

If you do not send `sort`, every list still has a fixed order that is the same from one page to the next, so paging never shuffles records. The default order differs by endpoint: the candidate list is ordered by name, and lists of events or transactions are normally newest first.

## Searching

Endpoints that offer it take a `search` parameter of up to 100 characters. How it matches depends on the endpoint, and the endpoint's page says which fields it looks at. For the Hub candidate list, every word you give must match the candidate's name, email, role or your own candidate reference. So `search=lee nurse` finds candidates that match both "lee" and "nurse" somewhere in those fields. Not every list has `search`. If a list does not support it, the parameter is ignored.

## Filtering

Other filters are named after the field they filter, for example `status=expired`, `compliance_status=expired`, `is_active=true` or `candidate_ref=...`. Each endpoint's page lists its filters and their allowed values. A value that is not allowed is a `422` that names the filter. Boolean filters accept `true`, `false`, `1` and `0`.

### Date ranges

Fields that hold a date or time have a pair of filters called `{name}_from` and `{name}_to`. The Hub candidate list has `updated_from` and `updated_to`, and `added_from` and `added_to`. Other endpoints have `created_from`, `start_date_from` and so on, and each endpoint's page names its own.

You may send a plain date (`2026-10-01`) or a full ISO 8601 time (`2026-10-01T09:30:00Z`). Both ends are inclusive. `_from` means "from the start of that day" and `_to` means "to the end of that day", both in UTC. So `updated_from=2026-10-01&updated_to=2026-10-01` returns everything changed during that one UTC day. In Clinical Interviews and Practical Training a plain date means a UK calendar day instead (Europe/London, so a day in summer starts at 23:00 UTC the evening before); the portal pages say which filters this applies to. A value that is not a date is a `422`, and so is a `_from` that is later than the `_to`; the error is reported on the `_to` field.

## Following `links.next`

Always page by following `links.next` rather than building page numbers yourself. The link already contains every filter, the sort and the page size from your original request, so you cannot lose a filter by mistake, and it will keep working if we add parameters. Stop when `links.next` is `null`.

Two precautions are worth taking:

- **Only follow links to the API's own host.** The links are absolute. Your code should check that the host matches the API's before it sends your bearer token there. The helpers below do.
- **Expect the data to move.** Paging is by page number, so records added or removed while you work can make a record appear twice or be missed across pages. To mirror data, sort by a stable field and fix any gaps on the next run, or sort by `updated_at` and use `updated_from` with a small overlap to pick up changes since your last sync, de-duplicating by `candidate_ref`. For reacting to changes as they happen, [webhooks](10-webhooks.md) are better than polling.

Remember that every page is one call against your hourly [rate limit](09-rate-limits.md). Use `per_page=100` for bulk reads.

## A helper that reads every page

Each sample below defines a generator or iterator that yields every record of a list and follows `links.next` until the end. They share a small token exchange and use the filter `compliance_status=expired` and the sort `-updated_at` as an example. They stop and raise an error if the API answers anything other than `200`.

### cURL

This needs `jq`. It prints the reference and name of each expired candidate, 100 to a page.

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'
ORIGIN='https://hub.hbcompliance.co.uk'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

URL="$BASE/hub/candidates?compliance_status=expired&sort=-updated_at&per_page=100"

while [ -n "$URL" ]; do
  case "$URL" in
    "$ORIGIN"/*) ;;
    *) echo "Refusing to follow a link to another host: $URL" >&2; exit 1 ;;
  esac

  PAGE=$(curl --silent --fail-with-body "$URL" \
    --header "Authorization: Bearer $ACCESS_TOKEN" \
    --header 'Accept: application/json')

  echo "$PAGE" | jq --raw-output '.data[] | [.candidate_ref, .name] | @tsv'

  URL=$(echo "$PAGE" | jq --raw-output '.links.next // empty')
done
```

### JavaScript

```javascript
const BASE = 'https://hub.hbcompliance.co.uk/api/v2';

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

/** Yields every record of a list, following links.next until it is null. */
async function* paginate(token, path, query = {}) {
  const first = new URL(`${BASE}${path}`);
  for (const [name, value] of Object.entries({ per_page: 100, ...query })) {
    first.searchParams.set(name, String(value));
  }

  let next = first.toString();

  while (next) {
    if (new URL(next).origin !== new URL(BASE).origin) {
      throw new Error(`Refusing to follow a link to another host: ${next}`);
    }

    const response = await fetch(next, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const page = await response.json();

    if (!response.ok) {
      throw new Error(`${page.error}: ${page.message} (request ${page.request_id})`);
    }

    yield* page.data;
    next = page.links.next;
  }
}

const token = await exchangeKey();
let count = 0;

for await (const candidate of paginate(token, '/hub/candidates', { compliance_status: 'expired', sort: '-updated_at' })) {
  count += 1;
  console.log(candidate.candidate_ref, candidate.name);
}

console.log(`${count} expired candidates`);
```

### PHP

```php
<?php

const HB_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

/** Returns [status, decoded body]. $url may be a path or an absolute URL. */
function hb_call(string $method, string $url, ?string $token = null, ?array $json = null): array
{
    $headers = ['Accept: application/json'];

    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
    }

    $curl = curl_init(str_starts_with($url, 'https://') ? $url : HB_BASE . $url);
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

/**
 * Yields every record of a list, following links.next until it is null.
 *
 * @param array<string, scalar> $query
 * @return Generator<int, array<string, mixed>>
 */
function hb_paginate(string $token, string $path, array $query = []): Generator
{
    $next = HB_BASE . $path . '?' . http_build_query(['per_page' => 100, ...$query], '', '&', PHP_QUERY_RFC3986);
    $expectedHost = parse_url(HB_BASE, PHP_URL_HOST);

    while ($next !== null) {
        if (parse_url($next, PHP_URL_HOST) !== $expectedHost) {
            throw new RuntimeException("Refusing to follow a link to another host: {$next}");
        }

        [$status, $page] = hb_call('GET', $next, $token);

        if ($status !== 200) {
            throw new RuntimeException("{$page['error']}: {$page['message']} (request {$page['request_id']})");
        }

        yield from $page['data'];
        $next = $page['links']['next'];
    }
}

[$status, $tokenAnswer] = hb_call('POST', '/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')]);

if ($status !== 200) {
    exit("Token exchange failed: {$tokenAnswer['error']}\n");
}

$count = 0;

foreach (hb_paginate($tokenAnswer['access_token'], '/hub/candidates', ['compliance_status' => 'expired', 'sort' => '-updated_at']) as $candidate) {
    $count++;
    echo "{$candidate['candidate_ref']} {$candidate['name']}\n";
}

echo "{$count} expired candidates\n";
```

### Python

```python
import os
from urllib.parse import urlparse

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


def paginate(token, path, params=None):
    """Yield every record of a list, following links.next until it is null."""
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}", "Accept": "application/json"})
    expected_host = urlparse(BASE).netloc

    next_url = f"{BASE}{path}"
    next_params = {"per_page": 100, **(params or {})}

    while next_url:
        if urlparse(next_url).netloc != expected_host:
            raise RuntimeError(f"Refusing to follow a link to another host: {next_url}")

        response = session.get(next_url, params=next_params, timeout=30)
        page = response.json()

        if response.status_code != 200:
            raise RuntimeError(f"{page['error']}: {page['message']} (request {page['request_id']})")

        yield from page["data"]
        next_url = page["links"]["next"]
        next_params = None  # the next link already carries every parameter


count = 0
for candidate in paginate(exchange_key(), "/hub/candidates", {"compliance_status": "expired", "sort": "-updated_at"}):
    count += 1
    print(candidate["candidate_ref"], candidate["name"])

print(f"{count} expired candidates")
```

## Quick reference

| You want | Send |
| --- | --- |
| The second page of 50 | `?page=2&per_page=50` |
| Newest first | `?sort=-created_at` (use a field from the endpoint's list) |
| A text search | `?search=smith` |
| Records changed on or after 1 October 2026 | `?updated_from=2026-10-01` |
| Only active candidates | `?is_active=true` |
| Several filters together | Combine them: `?compliance_status=expired&role=Staff%20Nurse&per_page=100` |

For other things that go wrong, such as a `422` you did not expect, see [errors](08-errors.md).
