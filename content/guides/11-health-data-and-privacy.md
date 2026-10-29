# Health data and privacy

Most of what the API returns is operational: bookings, course results, statuses. Some of it is more sensitive. Occupational Health holds a person's health questionnaire answers, clearance decisions and certificates. The clinical portals hold assessment reports. References holds what referees have written about a person. The monitoring portals hold registration and identity evidence. This guide explains what that means for your integration: which scopes open this data, where it is deliberately kept out, what is and is not logged, how to download files, and some plain advice for handling it.

It describes what the API does. It is not legal advice. Your own obligations depend on your organisation and the agreements you have with Healthier Business, and your data protection officer is the right person to ask about them.

## Which scopes open sensitive data

Treat the scopes below as the sensitive ones. Give them only to keys whose integration really needs them, and keep those keys apart from your general-purpose keys. [Scopes and permissions](04-scopes-and-permissions.md) explains how to choose scopes.

| Portal | Scope | What it opens |
| --- | --- | --- |
| Occupational Health | `occupational-health:requests:read` | Request detail (including the review note) and the questionnaire answers, which are health data |
| Occupational Health | `occupational-health:documents:read` | Supporting documents and Fit to Work certificates and fail letters |
| Occupational Health | `occupational-health:alerts:read` | Rejected and not-fit alerts, which name the candidate and describe the reason |
| Occupational Health | `occupational-health:reports:read`, `occupational-health:reports:write` | Generating and downloading reports of requests and expiries |
| Occupational Health | `occupational-health:candidates:read` | A candidate's occupational health history |
| Clinical Interviews | `clinical-interviews:bookings:read` | Bookings, with the candidate's name, email, phone and NMC number, and the interview report PDF |
| Clinical Appraisals | `clinical-appraisals:bookings:read` | Bookings, with the candidate's details, and the evaluation report PDF |
| References | `references:referees:read` | A referee's answers, score, decline reason and the reference PDF |
| Registration Monitoring | `registration-monitoring:evidence:read` | Evidence files and raw data of registration checks |
| DBS and Right To Work | `dbs-rtw:evidence:read` | DBS certificates, right to work screenshots and uploaded documents |

Notice that downloads do not have scopes of their own. The interview report, for example, is opened by the same `clinical-interviews:bookings:read` scope that lets a key list bookings. Think of such a scope as opening the reports too. The wildcards `occupational-health:*`, `{portal}:*` and `*` include all of this, which is one more reason not to use wildcards in production.

The API always limits data to your own organisation. A key can never read another client's records, and an id from another client answers `404 not_found`, the same as one that does not exist.

## What is never in a webhook

Webhook bodies are designed to carry identifiers, statuses and dates, and to leave the sensitive content out. The principle is that an event tells you something happened, and you then fetch the details from the API with a scoped key. What the events leave out:

- **Occupational Health.** Never questionnaire answers, review notes or document contents. Where a note exists, the body has a boolean such as `has_review_note`.
- **Clinical Interviews and Clinical Appraisals.** Never the candidate's name, email, phone number or the interview video link. Events carry the `candidate_ref`, ids, the interview or appraisal type and statuses. One event carries a little more: `clinical-interviews.booking.interview_report_available` includes the interview `outcome` and `score`, so treat that endpoint's logs accordingly.
- **References.** Never the referee's answers, name or email, and not the free-text decline reason (the event says only that a reason exists). The event tells you which reference to fetch.
- **Online Training and Practical Training.** No names or email addresses, only the `candidate_ref`, course and booking ids, statuses and dates.

Even so, the `candidate_ref` and the event type together say something about a person, for example that a request was rejected. Receive webhooks only over https, verify the signature of each one, and do not log request bodies more widely than you need to. [Webhooks](10-webhooks.md) describes verification.

## What is and is not logged on our side

Hub records every call made to the API in a call log, so that problems can be traced and misuse detected. A row holds the time, your key's reference (never the key itself), the path, the method, the status, the duration, the calling IP address and the `request_id`. For most endpoints it also holds the request and response bodies, after removing secrets such as keys and tokens, and cut to a maximum size. The call log is kept for six months by default.

For the endpoints that return occupational health data, the bodies are **not** recorded: the call is logged (key, path, status, duration), but neither the request nor the response body is stored. These are the request detail, the answers, the alerts, the document and Fit to Work downloads and the report downloads. In addition, Hub keeps an access trail of who viewed or downloaded occupational health data, recording identifiers only (the candidate, the submission, the document), with your API key as the actor.

Other portals' bodies are logged as above, with secrets removed. That is a reason to send only the fields an endpoint needs, and not to put personal data in places the API does not ask for it, such as free-text fields you do not need.

What is not logged by Hub is also your responsibility on your side. The sensitive data you receive passes through your own servers, proxies, load balancers and monitoring tools, so check what they record.

## Downloads

Files come from dedicated endpoints that stream the file with a content type such as `application/pdf` and a `Content-Disposition` header, not a JSON body. When something goes wrong the answer is the usual JSON error instead, so check the content type or status before you save the body. The download endpoints are:

| Portal | Endpoint | File |
| --- | --- | --- |
| Occupational Health | `GET /requests/{id}/documents/{file}` | A supporting document |
| Occupational Health | `GET /requests/{id}/ftw/{ftw}?source=submission` or `candidate` | A Fit to Work certificate or fail letter |
| Occupational Health | `GET /reports/{type}/{format}` | A generated report, as `xlsx`, `pdf` or `csv` |
| Clinical Interviews | `GET /bookings/{id}/interview-report` | The interview report PDF |
| Clinical Appraisals | `GET /bookings/{id}/evaluation-report` | The evaluation report PDF |
| References | `GET /referees/{uuid}/pdf` | The completed reference as a PDF |
| Registration Monitoring | `GET /evidence/{file}/download` | An evidence file |
| Online Training | `GET /candidates/{candidate_ref}/certificate` | A combined certificate PDF |
| Practical Training and Virtual BLS Training | `GET /bookings/{booking}/certificate` | An attendance or training certificate PDF |

Each portal's page lists the details, and the errors you can get. For example `422 report_not_available` means the report does not exist yet, and `410 report_expired` on an interview report means its retention period has ended. A document that is not yours, or does not exist, is `404`.

Some practical points about downloads:

- **Do not trust the file name.** If you save a file under the name the server suggests, a hostile name could write outside your directory. Name files yourself, for example by document id and a fixed extension chosen from the content type.
- **Stream large files to disk** instead of reading them into memory.
- **Store them somewhere private**, not under a public web directory, and with access limited to the people and systems that need them.
- **Download when you need a file**, rather than copying everything in advance. The API remains the source of truth.

The samples below list the documents of an Occupational Health request and save each one to a folder. They name the files from the document id, they check the content type, and they stop on an error. They need the scope `occupational-health:documents:read`. Pass the request id (the integer `id` of a request) as the first argument.

### cURL

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2/occupational-health'
AUTH_BASE='https://hub.hbcompliance.co.uk/api/v2'
REQUEST_ID="${1:?Usage: $0 <request id>}"
mkdir -p downloads

ACCESS_TOKEN=$(curl --silent --fail-with-body "$AUTH_BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

curl --silent --fail-with-body "$BASE/requests/$REQUEST_ID/documents" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json' \
  | jq --raw-output '.data[] | [.id, .type, (.source // "")] | @tsv' \
  | while IFS=$'\t' read -r ID TYPE SOURCE; do
      if [ "$TYPE" = 'ftw' ]; then
        URL="$BASE/requests/$REQUEST_ID/ftw/$ID?source=$SOURCE"
      else
        URL="$BASE/requests/$REQUEST_ID/documents/$ID"
      fi

      curl --silent --fail-with-body "$URL" \
        --header "Authorization: Bearer $ACCESS_TOKEN" \
        --output "downloads/request-$REQUEST_ID-$ID.bin"

      echo "Saved downloads/request-$REQUEST_ID-$ID.bin"
    done
```

The file extension is `.bin` here because the type depends on the document. Use `file --mime-type` on the result, or the `Content-Type` header, if you need to rename it.

### JavaScript

```javascript
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const AUTH_BASE = 'https://hub.hbcompliance.co.uk/api/v2';
const BASE = `${AUTH_BASE}/occupational-health`;
const requestId = process.argv[2];

if (!/^\d+$/.test(requestId ?? '')) {
  throw new Error('Usage: node download.mjs <request id>');
}

const EXTENSIONS = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

const tokenResponse = await fetch(`${AUTH_BASE}/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ api_key: process.env.HB_API_KEY }),
});
const { access_token: token } = await tokenResponse.json();
const headers = { Authorization: `Bearer ${token}` };

const listResponse = await fetch(`${BASE}/requests/${requestId}/documents`, {
  headers: { ...headers, Accept: 'application/json' },
});
const list = await listResponse.json();

if (!listResponse.ok) {
  throw new Error(`${list.error}: ${list.message} (request ${list.request_id})`);
}

await mkdir('downloads', { recursive: true });

for (const document of list.data) {
  const path =
    document.type === 'ftw'
      ? `/requests/${requestId}/ftw/${document.id}?source=${document.source}`
      : `/requests/${requestId}/documents/${document.id}`;

  const response = await fetch(`${BASE}${path}`, { headers });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0];

  if (!response.ok || contentType === 'application/json') {
    const failure = await response.json().catch(() => ({}));
    throw new Error(`Download failed: ${response.status} ${failure.error} (request ${failure.request_id})`);
  }

  const file = `downloads/request-${requestId}-${document.id}.${EXTENSIONS[contentType] ?? 'bin'}`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  console.log('Saved', file);
}
```

### PHP

```php
<?php

const HB_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

$requestId = $argv[1] ?? '';

if (! ctype_digit($requestId)) {
    exit("Usage: php download.php <request id>\n");
}

/** @return array{0: int, 1: string, 2: string} status, content type, body */
function hb_fetch(string $path, ?string $token, ?array $json = null): array
{
    $headers = ['Accept: application/json, application/pdf, */*'];

    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
    }

    $curl = curl_init(HB_BASE . $path);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CUSTOMREQUEST => $json === null ? 'GET' : 'POST',
    ]);

    if ($json !== null) {
        curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($json));
    }

    $body = curl_exec($curl);

    if ($body === false) {
        throw new RuntimeException('Network error: ' . curl_error($curl));
    }

    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $contentType = strtolower(explode(';', (string) curl_getinfo($curl, CURLINFO_CONTENT_TYPE))[0]);
    curl_close($curl);

    return [$status, $contentType, $body];
}

[, , $tokenBody] = hb_fetch('/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')]);
$token = json_decode($tokenBody, true)['access_token'];

[$status, , $listBody] = hb_fetch("/occupational-health/requests/{$requestId}/documents", $token);
$list = json_decode($listBody, true);

if ($status !== 200) {
    exit("{$list['error']}: {$list['message']} (request {$list['request_id']})\n");
}

$extensions = ['application/pdf' => 'pdf', 'image/jpeg' => 'jpg', 'image/png' => 'png'];

if (! is_dir('downloads')) {
    mkdir('downloads', 0700, true);
}

foreach ($list['data'] as $document) {
    $path = $document['type'] === 'ftw'
        ? "/occupational-health/requests/{$requestId}/ftw/{$document['id']}?source=" . rawurlencode((string) $document['source'])
        : "/occupational-health/requests/{$requestId}/documents/{$document['id']}";

    [$status, $contentType, $body] = hb_fetch($path, $token);

    if ($status !== 200 || $contentType === 'application/json') {
        $failure = json_decode($body, true);
        exit("Download failed: {$status} {$failure['error']} (request {$failure['request_id']})\n");
    }

    $file = sprintf('downloads/request-%s-%s.%s', $requestId, (int) $document['id'], $extensions[$contentType] ?? 'bin');
    file_put_contents($file, $body);
    chmod($file, 0600);
    echo "Saved {$file}\n";
}
```

### Python

```python
import os
import sys

import requests

AUTH_BASE = "https://hub.hbcompliance.co.uk/api/v2"
BASE = f"{AUTH_BASE}/occupational-health"
EXTENSIONS = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png"}

if len(sys.argv) != 2 or not sys.argv[1].isdigit():
    sys.exit("Usage: python3 download.py <request id>")

request_id = sys.argv[1]

token = requests.post(
    f"{AUTH_BASE}/auth/token",
    json={"api_key": os.environ["HB_API_KEY"]},
    headers={"Accept": "application/json"},
    timeout=30,
).json()["access_token"]
headers = {"Authorization": f"Bearer {token}"}

listing = requests.get(
    f"{BASE}/requests/{request_id}/documents",
    headers={**headers, "Accept": "application/json"},
    timeout=30,
)
body = listing.json()

if listing.status_code != 200:
    sys.exit(f"{body['error']}: {body['message']} (request {body['request_id']})")

os.makedirs("downloads", mode=0o700, exist_ok=True)

for document in body["data"]:
    if document["type"] == "ftw":
        url = f"{BASE}/requests/{request_id}/ftw/{document['id']}"
        params = {"source": document["source"]}
    else:
        url = f"{BASE}/requests/{request_id}/documents/{document['id']}"
        params = None

    with requests.get(url, params=params, headers=headers, stream=True, timeout=60) as response:
        content_type = response.headers.get("Content-Type", "").split(";")[0]

        if response.status_code != 200 or content_type == "application/json":
            failure = response.json()
            sys.exit(f"Download failed: {response.status_code} {failure.get('error')} (request {failure.get('request_id')})")

        path = f"downloads/request-{request_id}-{int(document['id'])}.{EXTENSIONS.get(content_type, 'bin')}"
        with open(path, "wb") as handle:
            for chunk in response.iter_content(chunk_size=65536):
                handle.write(chunk)
        print("Saved", path)
```

The list of documents answers `200` with the usual envelope. The fields below are those the Occupational Health page documents for each document: `id`, `type` (`supporting` or `ftw`), `source`, `filename`, `size`, `uploaded_at`, `general` and `download_url`:

```json
{
  "data": [
    {
      "id": 311,
      "type": "ftw",
      "source": "submission",
      "filename": "fit-to-work.pdf",
      "size": 48213,
      "uploaded_at": "2026-10-28T19:53:24Z",
      "general": false,
      "download_url": "https://hub.hbcompliance.co.uk/api/v2/occupational-health/requests/5/ftw/311?source=submission"
    }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 },
  "links": {
    "first": "https://hub.hbcompliance.co.uk/api/v2/occupational-health/requests/5/documents?page=1",
    "last": "https://hub.hbcompliance.co.uk/api/v2/occupational-health/requests/5/documents?page=1",
    "prev": null,
    "next": null
  }
}
```

The values, the `download_url` form and the example numbers are illustrative: read the real ones from your own answers. The samples build the download address themselves from the document `id`, as the endpoint table above shows, and ignore `download_url`.

## Retention

Hub keeps the data in your account for as long as your account and its settings require, and the API reads from that data. The facts below are the ones the platform establishes:

- **The call log** is kept for six months by default, then removed automatically.
- **Interview outcome PDFs** are available only for a retention period. After it, `GET /bookings/{id}/interview-report` answers `410 report_expired`. Download and file what you need to keep before then, if your own rules require it.
- **Reference answers** are removed after the keeping period that each client sets in the References settings. A reference you have fetched stays on your side, under your own rules.
- **The occupational health access trail** (who viewed or downloaded what, recorded by identifier) is not part of the call log, and our configuration does not remove it automatically.

This guide states no retention period for other data, because the platform does not set one for it. Data you copy out of the API is yours to manage.

## Handling the data you receive

These points are short and factual, and they apply to any personal data:

- **Take only what you need.** Request only the endpoints and fields you will use, and do not copy whole data sets into other systems on the off chance they are useful.
- **Use a separate, narrowly scoped key** for any integration that touches health, assessment or reference data, with an expiry date and, where possible, an [IP allowlist](05-ip-allowlisting.md).
- **Control who can see it.** Limit access inside your organisation to the people and systems that need it, and keep records of who downloaded what, as Hub does on its side.
- **Protect it in transit and at rest.** The API is https only. Store downloaded files and any copies in encrypted storage, not on shared drives or in public buckets.
- **Keep it out of logs, tickets and email.** Log `request_id` and ids, not names, answers or file contents. Do not send health data to chat tools or error trackers, and check that your exception tracking does not capture response bodies.
- **Do not put real people's data in test systems.** Use the [sandbox](12-testing-and-sandbox.md), which is designed for synthetic data, and never real data, when it is available.
- **Delete what you no longer need** according to your own retention policy, and delete it everywhere, including backups, in line with that policy.
- **Know your agreements.** Your organisation's data protection duties, and any data processing agreement with Healthier Business, apply to data you receive through the API in the same way as to data you see in the Hub. Your data protection officer can advise.
- **Report a problem quickly.** If you think a key has leaked or data has gone to the wrong place, regenerate the key at once on the Developer page and tell your own data protection contact. See [going live](13-going-live.md) for the checklist.
