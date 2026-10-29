# Webhooks

A webhook is a call that Hub makes to your server when something happens, so that you do not have to keep asking. When a candidate passes a course, when an occupational health request is cleared, when a booking is cancelled, Hub sends a signed `POST` with a small JSON description to an address you chose. Webhooks are cheaper than polling, they arrive within moments, and they do not count against your hourly [rate limit](09-rate-limits.md).

There is a single webhook system for the whole Hub. You register an endpoint once, choose events from any portal, and receive them all at that address with one signing secret. Event names have the form `{portal}.{event}`, for example `online-training.course.completed`.

## Creating an endpoint

You can create endpoints in two ways.

- **On the Developer page** in the Hub, open the **Webhooks** tab and choose **Add webhook**. The page also shows the delivery log of each endpoint.
- **Through the API**, with `POST /api/v2/webhooks`. The key needs the scope `account:webhooks:write` (and `account:webhooks:read` to list and read, although write implies read).

The body has these fields:

| Field | Rule |
| --- | --- |
| `name` | Required, up to 100 characters. A label for you |
| `url` | Required, a full `https://` address of up to 2048 characters. See "URL rules" below |
| `events` | Required, a list with at least one event name from the list in this guide, or from `GET /webhooks/events` |
| `is_active` | Optional, default `true` |
| `timeout_seconds` | Optional, from 5 to 30, default 10. How long Hub waits for your answer |

The answer is `201`. The endpoint resources of this API are returned directly and not wrapped in `data`. The answer includes the **signing secret**, which is shown only once:

```json
{
  "id": 7,
  "name": "Rota system",
  "url": "https://example.com/hooks/hub",
  "events": ["online-training.course.completed", "occupational-health.request.full_clearance"],
  "is_active": true,
  "timeout_seconds": 10,
  "secret_prefix": "whsec_PwZPf1••••••••",
  "last_delivered_at": null,
  "last_response_code": null,
  "consecutive_failures": 0,
  "imported": false,
  "created_at": "2026-10-28T19:53:24Z",
  "signing_secret": "whsec_PwZPf1Qh6yYTWmE4lBYOvfZ8UzDzV8fUkkibjL5DZPjN0MEQ",
  "notice": "Store the signing secret now. It is not shown again."
}
```

Store `signing_secret` in your secret store immediately. Afterwards only `secret_prefix` (the first 12 characters) is shown, enough to recognise the secret but not to use it. If you lose the secret, rotate it (below).

The other endpoint-management calls are:

| Call | Purpose |
| --- | --- |
| `GET /webhooks` | List your endpoints. Filters `is_active`, `search`, `created_from`, `created_to`. Sort by `id`, `name` or `created_at` |
| `GET /webhooks/{id}` | Read one endpoint |
| `PUT /webhooks/{id}` | Change the fields you send. Send `is_active: true` to switch a disabled endpoint back on |
| `DELETE /webhooks/{id}` | Delete the endpoint. Events stop being sent at once |
| `GET /webhooks/events` | List every event you can choose, grouped by portal |
| `POST /webhooks/{id}/test` | Send a test event |
| `POST /webhooks/{id}/rotate-secret` | Create a new signing secret |
| `GET /webhooks/{id}/deliveries` | List the delivery attempts of an endpoint |
| `POST /webhooks/{id}/deliveries/{delivery}/redeliver` | Send an event again |

Another client's endpoint answers `404 not_found`, as with every resource.

## Choosing events

Choose only the events you will act on. Each portal's page in [the portals folder](../portals/) describes its events and shows the `data` fields in detail. The events, by portal, are:

**Online Training** (`online-training.`): `course.assigned`, `course.completed`, `training.completed`, `training.expiring`, `training.expired`, `certificate.issued`.

**Occupational Health** (`occupational-health.`): `request.submitted`, `request.awaiting_candidate`, `request.questionnaire_completed`, `request.rejected`, `request.full_clearance`, `request.temporary_clearance`, `request.fail`, `document.available`, `renewal.due`.

**Practical Training** (`practical-training.`): `booking.created`, `booking.confirmed`, `booking.rescheduled`, `booking.cancelled`, `booking.attendance_marked`, `booking.no_show`, `booking.certificate_available`, `booking_invite.sent`, `booking_invite.opened`, `booking_invite.used`, `balance.low`, `balance.depleted`, `credits.low`, `credits.depleted`, `training_event.seats_low`, `slot_hold.expired`.

**Virtual BLS Training** (`virtual-bls-training.`): `booking.created`, `booking.confirmed`, `booking.rescheduled`, `booking.cancelled`, `booking.attendance_marked`, `booking.equipment_late`, `booking.certificate_available`.

**Clinical Interviews** (`clinical-interviews.`): `booking.created`, `booking.confirmed`, `booking.rescheduled`, `booking.cancelled`, `booking.interview_completed`, `booking.attendance_marked`, `booking.interview_report_available`.

**Clinical Appraisals** (`clinical-appraisals.`): `booking.created`, `booking.confirmed`.

**References** (`references.`): `reference.request.created`, `reference.submitted`, `reference.declined`, `reference.expired`, `reference.reminder.sent`, `reference.all_completed`, `candidate.referees.submitted`.

**Registration Monitoring** (`registration-monitoring.`): `worker.status_changed`, `worker.initial_verification`.

**DBS and Right To Work** (`dbs-rtw.`): `dbs.status_changed`, `rtw.status_changed`, `alert.raised`.

Add the portal prefix when you register them: `practical-training.booking.created`, `references.reference.submitted`, `dbs-rtw.alert.raised`. An event name that is not in the list is refused with `422` on `events`. The Hub core API (candidates) has no webhook events yet. There is also one special event, `webhook.test`, which you do not subscribe to: it is sent only when you ask for a test.

A few events depend on scheduled jobs and may not be switched on for every account. The Online Training events `training.expiring` and `training.expired`, for example, follow the renewal reminder emails and so cover only candidates who receive those reminders.

## The envelope

Every delivery is an HTTP `POST` with a JSON body in this shape:

```json
{
  "event_id": "e8c14743-7abe-4539-807d-1034d726c86b",
  "event_type": "online-training.course.completed",
  "occurred_at": "2026-10-28T19:53:24Z",
  "data": {
    "candidate_ref": "78572976-3a12-417c-9a26-f88938703800",
    "course_id": 12,
    "course_name": "Fire Safety",
    "status": "completed",
    "assigned_at": "2026-08-31T09:00:00Z",
    "completed_at": "2026-09-01T09:00:00Z",
    "expires_at": "2027-09-01T09:00:00Z",
    "grade": 1
  }
}
```

| Field | Meaning |
| --- | --- |
| `event_id` | A uuid that identifies this event. It is the same on every retry and redelivery, so use it to detect duplicates |
| `event_type` | The event name, with the portal prefix |
| `occurred_at` | When the event happened, in ISO 8601 UTC with a `Z` |
| `data` | The event's details. Each event's fields are on its portal's page |

An example from Occupational Health shows how little `data` holds:

```json
{
  "event_id": "7b8f2ab5-3451-4013-9675-f6ad325b55dd",
  "event_type": "occupational-health.request.full_clearance",
  "occurred_at": "2026-10-28T19:53:24Z",
  "data": {
    "request_id": 5,
    "submission_id": 4821,
    "candidate_ref": "78572976-3a12-417c-9a26-f88938703800",
    "status": "full_clearance",
    "reference": "OH-5",
    "submission_reference": "202610281953004821",
    "form": "clinical_occupational_health",
    "has_review_note": false,
    "next_renewal": "2027-10-28"
  }
}
```

The test event is simpler. It is the only event whose name has no portal prefix:

```json
{
  "event_id": "9c3a23cd-e67a-4b75-bc39-47249fc2d0a1",
  "event_type": "webhook.test",
  "occurred_at": "2026-10-28T19:53:24Z",
  "data": { "message": "HB Compliance Hub webhook test event", "endpoint_id": 7 }
}
```

### Payloads carry ids and statuses, not personal data

Webhook bodies are deliberately small. They carry identifiers (`candidate_ref`, booking and request ids), statuses and dates. They do not carry names, email addresses, questionnaire answers, review notes or document contents. Where a body has a flag such as `has_review_note`, it tells you that something exists, and you fetch it from the API with a key that has the right scope. This keeps sensitive information off the wire and out of your web server logs, and it means a webhook alone is never enough to expose a person's data. Use the event as a prompt to call the API, for example `GET /hub/candidates/{candidate_ref}`. See [health data and privacy](11-health-data-and-privacy.md).

## Delivery headers

Each delivery has these headers, in addition to `Content-Type: application/json`:

| Header | Value |
| --- | --- |
| `X-Hub-Event` | The event name, the same as `event_type` |
| `X-Hub-Event-Id` | The `event_id` |
| `X-Hub-Delivery-Id` | The number of this delivery in the delivery log |
| `X-Hub-Timestamp` | The time this attempt was made, as Unix seconds, for example `1793209404` |
| `X-Hub-Signature` | The signature, in the form `sha256=` followed by 64 hexadecimal characters |

If your endpoint was imported from an older portal's webhook, Hub also sends that portal's own headers and event names, in the old format, so that your existing receiver keeps working. The `imported` field of the endpoint tells you. Everything in this guide describes the standard format.

## Verifying the signature

Always verify the signature before you trust a delivery. Anyone who knows your URL can send you a `POST`, but only Hub and you know the secret.

The signature is an HMAC with SHA-256. The input is the timestamp, a full stop, and then the raw request body, exactly as received. The key is your signing secret, the whole string including its `whsec_` prefix. The result is written in lower-case hexadecimal and prefixed with `sha256=`:

```
X-Hub-Signature = "sha256=" + hex( HMAC_SHA256( key = signing_secret,
                                                message = X-Hub-Timestamp + "." + raw_body ) )
```

Some points are essential:

- **Use the raw body.** Verify the exact bytes you received. If you parse the JSON and serialise it again, the spacing or key order may differ and the signature will not match. Read the raw body first, verify, and only then parse.
- **Use the `X-Hub-Timestamp` header** as the timestamp part, as the text it arrives in.
- **Compare in constant time**, with a function made for it (`crypto.timingSafeEqual`, `hash_equals`, `hmac.compare_digest`), not with `==`.
- **Check the timestamp.** The signature covers the timestamp, so an attacker cannot change it. Reject a delivery whose timestamp is too far from your clock, to stop someone replaying an old captured request. Hub does not impose a tolerance, so choose one. We suggest five minutes (300 seconds), and make sure your server clock is kept right with NTP. Each retry is signed afresh with a new timestamp, so a retry an hour later still passes.
- **Reject with `401` or `400`, not `200`**, when verification fails.

A known answer lets you test your code. With the secret `whsec_PwZPf1Qh6yYTWmE4lBYOvfZ8UzDzV8fUkkibjL5DZPjN0MEQ`, the timestamp `1793209404` and this body (one line, no trailing newline):

```
{"event_id":"e8c14743-7abe-4539-807d-1034d726c86b","event_type":"online-training.course.completed","occurred_at":"2026-10-28T19:53:24Z","data":{"candidate_ref":"78572976-3a12-417c-9a26-f88938703800","course_id":12,"course_name":"Fire Safety","status":"completed","assigned_at":"2026-08-31T09:00:00Z","completed_at":"2026-09-01T09:00:00Z","expires_at":"2027-09-01T09:00:00Z","grade":1}}
```

the correct signature is:

```
sha256=8e00191cf29c4259485b3b6fdf5b05aa9a5b9b0c3bb4c77ed8c5c06a3af2b456
```

Each receiver below verifies the signature with a tolerance of 300 seconds, parses the body, ignores an `event_id` it has seen before, and answers `200` at once. It does the real work after answering. Each also has a self-test mode that checks the known answer above.

### cURL

This script sends a correctly signed test delivery to your own receiver, which is the quickest way to try the code in the other languages. It needs `openssl`. Set `HB_WEBHOOK_SECRET` to the secret the receiver uses and, if you wish, `RECEIVER_URL`.

```bash
#!/usr/bin/env bash
set -euo pipefail

SECRET="${HB_WEBHOOK_SECRET:?Set HB_WEBHOOK_SECRET}"
URL="${RECEIVER_URL:-http://localhost:8080/hooks/hub}"
TIMESTAMP=$(date +%s)
BODY='{"event_id":"e8c14743-7abe-4539-807d-1034d726c86b","event_type":"online-training.course.completed","occurred_at":"2026-10-28T19:53:24Z","data":{"candidate_ref":"78572976-3a12-417c-9a26-f88938703800","course_id":12,"course_name":"Fire Safety","status":"completed","assigned_at":"2026-08-31T09:00:00Z","completed_at":"2026-09-01T09:00:00Z","expires_at":"2027-09-01T09:00:00Z","grade":1}}'

SIGNATURE="sha256=$(printf '%s' "$TIMESTAMP.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl --silent --write-out '\nHTTP status: %{http_code}\n' "$URL" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'X-Hub-Event: online-training.course.completed' \
  --header 'X-Hub-Event-Id: e8c14743-7abe-4539-807d-1034d726c86b' \
  --header "X-Hub-Timestamp: $TIMESTAMP" \
  --header "X-Hub-Signature: $SIGNATURE" \
  --data-raw "$BODY"
```

### JavaScript

Node 18 or later, with no packages. Save it as `receiver.mjs`. Run `node receiver.mjs test` for the self-test, or `HB_WEBHOOK_SECRET=whsec_... node receiver.mjs` to listen on port 8080.

```javascript
import crypto from 'node:crypto';
import http from 'node:http';

const TOLERANCE_SECONDS = 300;

/** True when the signature matches and the timestamp is within the tolerance. */
export function verify(rawBody, headers, secret, nowSeconds = Date.now() / 1000) {
  const timestamp = headers['x-hub-timestamp'];
  const signature = headers['x-hub-signature'];

  if (typeof timestamp !== 'string' || typeof signature !== 'string' || !/^\d+$/.test(timestamp)) {
    return false;
  }

  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
    return false;
  }

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(signature);

  return expectedBytes.length === receivedBytes.length && crypto.timingSafeEqual(expectedBytes, receivedBytes);
}

const seenEventIds = new Set(); // use a database or cache with an expiry in production

async function handleEvent(event) {
  console.log(`Handling ${event.event_type} for ${event.data.candidate_ref ?? 'no candidate'}`);
  // Fetch details from the API here if you need them.
}

if (process.argv[2] === 'test') {
  const secret = 'whsec_PwZPf1Qh6yYTWmE4lBYOvfZ8UzDzV8fUkkibjL5DZPjN0MEQ';
  const body = Buffer.from(
    '{"event_id":"e8c14743-7abe-4539-807d-1034d726c86b","event_type":"online-training.course.completed","occurred_at":"2026-10-28T19:53:24Z","data":{"candidate_ref":"78572976-3a12-417c-9a26-f88938703800","course_id":12,"course_name":"Fire Safety","status":"completed","assigned_at":"2026-08-31T09:00:00Z","completed_at":"2026-09-01T09:00:00Z","expires_at":"2027-09-01T09:00:00Z","grade":1}}',
  );
  const headers = {
    'x-hub-timestamp': '1793209404',
    'x-hub-signature': 'sha256=8e00191cf29c4259485b3b6fdf5b05aa9a5b9b0c3bb4c77ed8c5c06a3af2b456',
  };

  console.log('Valid signature accepted:', verify(body, headers, secret, 1793209404));
  console.log('Tampered body rejected:', !verify(Buffer.from(`${body}x`), headers, secret, 1793209404));
  console.log('Old timestamp rejected:', !verify(body, headers, secret, 1793209404 + 3600));
} else {
  const secret = process.env.HB_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('Set HB_WEBHOOK_SECRET to the endpoint signing secret.');
  }

  http
    .createServer((request, response) => {
      const chunks = [];

      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const rawBody = Buffer.concat(chunks);

        if (request.method !== 'POST' || !verify(rawBody, request.headers, secret)) {
          response.writeHead(401).end();
          return;
        }

        const event = JSON.parse(rawBody.toString('utf8'));

        if (!seenEventIds.has(event.event_id)) {
          seenEventIds.add(event.event_id);
          setImmediate(() => handleEvent(event).catch(console.error));
        }

        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"received":true}');
      });
    })
    .listen(8080, () => console.log('Listening on http://localhost:8080'));
}
```

### PHP

No packages. Save it as `receiver.php`. Run `php receiver.php test` for the self-test, or serve it with `HB_WEBHOOK_SECRET=whsec_... php -S localhost:8080 receiver.php`. In production, put the same logic in a route of your own application.

```php
<?php

const TOLERANCE_SECONDS = 300;

/** @param array<string, string> $headers lower-case header names */
function verify_signature(string $rawBody, array $headers, string $secret, ?int $now = null): bool
{
    $timestamp = $headers['x-hub-timestamp'] ?? '';
    $signature = $headers['x-hub-signature'] ?? '';

    if (! ctype_digit($timestamp) || $signature === '') {
        return false;
    }

    if (abs(($now ?? time()) - (int) $timestamp) > TOLERANCE_SECONDS) {
        return false;
    }

    $expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);

    return hash_equals($expected, $signature);
}

function already_seen(string $eventId): bool
{
    if (preg_match('/^[0-9a-f-]{36}$/', $eventId) !== 1) {
        return false;
    }

    // Use a database or cache with an expiry in production.
    $marker = sys_get_temp_dir() . '/hb-seen-' . $eventId;

    if (file_exists($marker)) {
        return true;
    }

    touch($marker);

    return false;
}

if (PHP_SAPI === 'cli') {
    $secret = 'whsec_PwZPf1Qh6yYTWmE4lBYOvfZ8UzDzV8fUkkibjL5DZPjN0MEQ';
    $body = '{"event_id":"e8c14743-7abe-4539-807d-1034d726c86b","event_type":"online-training.course.completed","occurred_at":"2026-10-28T19:53:24Z","data":{"candidate_ref":"78572976-3a12-417c-9a26-f88938703800","course_id":12,"course_name":"Fire Safety","status":"completed","assigned_at":"2026-08-31T09:00:00Z","completed_at":"2026-09-01T09:00:00Z","expires_at":"2027-09-01T09:00:00Z","grade":1}}';
    $headers = [
        'x-hub-timestamp' => '1793209404',
        'x-hub-signature' => 'sha256=8e00191cf29c4259485b3b6fdf5b05aa9a5b9b0c3bb4c77ed8c5c06a3af2b456',
    ];

    echo 'Valid signature accepted: ', var_export(verify_signature($body, $headers, $secret, 1793209404), true), "\n";
    echo 'Tampered body rejected: ', var_export(! verify_signature($body . 'x', $headers, $secret, 1793209404), true), "\n";
    echo 'Old timestamp rejected: ', var_export(! verify_signature($body, $headers, $secret, 1793209404 + 3600), true), "\n";
    exit(0);
}

$secret = (string) getenv('HB_WEBHOOK_SECRET');
$rawBody = (string) file_get_contents('php://input');
$headers = [
    'x-hub-timestamp' => $_SERVER['HTTP_X_HUB_TIMESTAMP'] ?? '',
    'x-hub-signature' => $_SERVER['HTTP_X_HUB_SIGNATURE'] ?? '',
];

if ($_SERVER['REQUEST_METHOD'] !== 'POST' || $secret === '' || ! verify_signature($rawBody, $headers, $secret)) {
    http_response_code(401);
    exit;
}

$event = json_decode($rawBody, true);

http_response_code(200);
header('Content-Type: application/json');
echo '{"received":true}';

if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
}

if (is_array($event) && ! already_seen((string) ($event['event_id'] ?? ''))) {
    error_log("Handling {$event['event_type']} for " . ($event['data']['candidate_ref'] ?? 'no candidate'));
    // Fetch details from the API here if you need them.
}
```

### Python

Standard library only. Save it as `receiver.py`. Run `python3 receiver.py test` for the self-test, or `HB_WEBHOOK_SECRET=whsec_... python3 receiver.py` to listen on port 8080. For production, use the same `verify` function inside your web framework's request handler.

```python
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

TOLERANCE_SECONDS = 300
seen_event_ids = set()  # use a database or cache with an expiry in production


def verify(raw_body, headers, secret, now=None):
    """True when the signature matches and the timestamp is within the tolerance."""
    timestamp = headers.get("X-Hub-Timestamp", "")
    signature = headers.get("X-Hub-Signature", "")

    if not timestamp.isdigit() or not signature:
        return False

    if abs((now if now is not None else time.time()) - int(timestamp)) > TOLERANCE_SECONDS:
        return False

    message = timestamp.encode() + b"." + raw_body
    expected = "sha256=" + hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()

    return hmac.compare_digest(expected, signature)


def handle_event(event):
    print(f"Handling {event['event_type']} for {event['data'].get('candidate_ref', 'no candidate')}")
    # Fetch details from the API here if you need them.


class Receiver(BaseHTTPRequestHandler):
    secret = os.environ.get("HB_WEBHOOK_SECRET", "")

    def do_POST(self):
        raw_body = self.rfile.read(int(self.headers.get("Content-Length", 0)))

        if not self.secret or not verify(raw_body, self.headers, self.secret):
            self.send_response(401)
            self.end_headers()
            return

        event = json.loads(raw_body)

        if event["event_id"] not in seen_event_ids:
            seen_event_ids.add(event["event_id"])
            threading.Thread(target=handle_event, args=(event,)).start()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"received":true}')


if sys.argv[1:] == ["test"]:
    secret = "whsec_PwZPf1Qh6yYTWmE4lBYOvfZ8UzDzV8fUkkibjL5DZPjN0MEQ"
    body = (
        b'{"event_id":"e8c14743-7abe-4539-807d-1034d726c86b","event_type":"online-training.course.completed",'
        b'"occurred_at":"2026-10-28T19:53:24Z","data":{"candidate_ref":"78572976-3a12-417c-9a26-f88938703800",'
        b'"course_id":12,"course_name":"Fire Safety","status":"completed","assigned_at":"2026-08-31T09:00:00Z",'
        b'"completed_at":"2026-09-01T09:00:00Z","expires_at":"2027-09-01T09:00:00Z","grade":1}}'
    )
    headers = {
        "X-Hub-Timestamp": "1793209404",
        "X-Hub-Signature": "sha256=8e00191cf29c4259485b3b6fdf5b05aa9a5b9b0c3bb4c77ed8c5c06a3af2b456",
    }

    print("Valid signature accepted:", verify(body, headers, secret, 1793209404))
    print("Tampered body rejected:", not verify(body + b"x", headers, secret, 1793209404))
    print("Old timestamp rejected:", not verify(body, headers, secret, 1793209404 + 3600))
elif __name__ == "__main__":
    print("Listening on http://localhost:8080")
    HTTPServer(("", 8080), Receiver).serve_forever()
```

All three self-tests print three lines that end in `true` (`True` in Python).

## Responding

Answer with any `2xx` status as quickly as you can. Hub treats a `2xx` as success and anything else as a failure. That includes `3xx`: Hub does not follow redirects, so register the final address of your endpoint and not one that redirects. It also includes a timeout. Hub waits for the time in `timeout_seconds` (10 seconds unless you set it) for an answer, and for 5 seconds to connect.

Do your real work after you have answered. Verify the signature, record the event (for example on a queue or in a table) and return `200`. Then process it. A slow handler that does a lot before answering risks a timeout, which Hub treats as a failure and retries, and then you handle the event twice.

Hub keeps the first 5,000 characters of your answer and the status code in its delivery log, which helps you debug. It is wise to keep your answer small and free of secrets.

## Retries

If a delivery fails (a non-`2xx` answer, a timeout or a connection error), Hub tries again. It makes **up to five attempts** in total. The pause before each retry grows:

| Attempt | Pause before it |
| --- | --- |
| 1 | none, sent as soon as the event happens |
| 2 | 1 minute after the first fails |
| 3 | 5 minutes after the second fails |
| 4 | 15 minutes after the third fails |
| 5 | 1 hour after the fourth fails |

So the last attempt happens about an hour and 20 minutes after the first. The body, the `event_id` and the `X-Hub-Delivery-Id` are identical on every attempt. The `X-Hub-Timestamp` and `X-Hub-Signature` are new each time. If the fifth attempt fails the delivery is marked `failed` and Hub does not try again by itself. Failed deliveries stay in the delivery log, and you can send one again with a redelivery (below).

The statuses of a delivery are `pending` (queued, not yet tried), `retrying` (tried and failed, another attempt is due), `delivered` and `failed`.

### An endpoint that keeps failing is switched off

If deliveries to an endpoint keep failing, Hub eventually stops sending to it. Every delivery that fails its fifth attempt adds one to the endpoint's `consecutive_failures`. A successful delivery resets the count to zero. When the count reaches **25**, Hub sets the endpoint to `is_active: false`, and events are no longer sent to it. Deliveries still waiting for it are marked failed.

You will see this in the `is_active` and `consecutive_failures` fields of the endpoint, and on the Developer page. This is the same in a sandbox of the developer portal, with one difference: there a `webhook.test` event is tried once, never retried, and does not count towards the 25. On the live Hub a test event follows the same schedule as a real event, so a test event that fails all five attempts adds one to `consecutive_failures` like any other delivery.

Fix your receiver, then switch the endpoint on again, either on the Developer page or with `PUT /webhooks/{id}` and `{"is_active": true}`. Switching it on also resets the failure count. Events that happened while it was off are not queued for later, so if you need them, fetch what you missed through the API.

## Delivery log, redelivery and test events

`GET /webhooks/{id}/deliveries` lists the attempts for an endpoint, newest first. You can filter by `status`, `event_type` and `created_from` and `created_to`. Each row has the delivery `id`, `event_type`, `event_id`, `status`, `attempt`, `response_code`, `delivered_at` and `created_at`:

```json
{
  "data": [
    {
      "id": 1042,
      "event_type": "online-training.course.completed",
      "event_id": "e8c14743-7abe-4539-807d-1034d726c86b",
      "status": "failed",
      "attempt": 5,
      "response_code": 503,
      "delivered_at": null,
      "created_at": "2026-10-28T19:53:24Z"
    }
  ],
  "meta": { "page": 1, "per_page": 25, "total": 1, "last_page": 1, "from": 1, "to": 1 },
  "links": {
    "first": "https://hub.hbcompliance.co.uk/api/v2/webhooks/7/deliveries?page=1",
    "last": "https://hub.hbcompliance.co.uk/api/v2/webhooks/7/deliveries?page=1",
    "prev": null,
    "next": null
  }
}
```

To send an event again, for example after you have fixed a bug, call `POST /webhooks/{id}/deliveries/{delivery}/redeliver`. It queues the same event as a fresh series of attempts, with the same body and `event_id`, and answers:

```json
{ "message": "The delivery has been queued again." }
```

To check that your endpoint and signature code work, call `POST /webhooks/{id}/test`. It sends the `webhook.test` event shown earlier, whether or not the endpoint subscribes to it, and answers with the delivery you can follow in the log. An endpoint that is switched off answers `422` with the code `webhook_inactive`:

```json
{ "message": "A test event has been queued.", "delivery_id": 1043 }
```

The samples below create an endpoint, send a test event, and read the delivery log after a few seconds. They read your key from `HB_API_KEY` and need the scope `account:webhooks:write`. Change `url` to your own public https address. They print the signing secret once, so run them somewhere safe and store it.

### cURL

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

ENDPOINT=$(curl --silent --fail-with-body "$BASE/webhooks" \
  --request POST \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data '{
    "name": "Rota system",
    "url": "https://example.com/hooks/hub",
    "events": ["online-training.course.completed", "occupational-health.request.full_clearance"]
  }')

echo "$ENDPOINT" | jq '{id, signing_secret}'
WEBHOOK_ID=$(echo "$ENDPOINT" | jq --raw-output '.id')

curl --silent --fail-with-body "$BASE/webhooks/$WEBHOOK_ID/test" \
  --request POST \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json'

sleep 5

curl --silent --fail-with-body "$BASE/webhooks/$WEBHOOK_ID/deliveries" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json' | jq '.data'
```

### JavaScript

```javascript
const BASE = 'https://hub.hbcompliance.co.uk/api/v2';

async function call(method, path, token, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`${payload?.error}: ${payload?.message} (request ${payload?.request_id})`);
  }

  return payload;
}

const { access_token: token } = await call('POST', '/auth/token', null, { api_key: process.env.HB_API_KEY });

const endpoint = await call('POST', '/webhooks', token, {
  name: 'Rota system',
  url: 'https://example.com/hooks/hub',
  events: ['online-training.course.completed', 'occupational-health.request.full_clearance'],
});

console.log('Endpoint', endpoint.id, '- store this secret now:', endpoint.signing_secret);

const test = await call('POST', `/webhooks/${endpoint.id}/test`, token);
console.log(test.message, 'delivery', test.delivery_id);

await new Promise((resolve) => setTimeout(resolve, 5000));

const log = await call('GET', `/webhooks/${endpoint.id}/deliveries`, token);
for (const delivery of log.data) {
  console.log(delivery.id, delivery.event_type, delivery.status, delivery.response_code);
}
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
    $body = json_decode($raw, true);

    if ($status >= 400) {
        throw new RuntimeException("{$body['error']}: {$body['message']} (request {$body['request_id']})");
    }

    return $body;
}

$token = hb_call('POST', '/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')])['access_token'];

$endpoint = hb_call('POST', '/webhooks', $token, [
    'name' => 'Rota system',
    'url' => 'https://example.com/hooks/hub',
    'events' => ['online-training.course.completed', 'occupational-health.request.full_clearance'],
]);

echo "Endpoint {$endpoint['id']} - store this secret now: {$endpoint['signing_secret']}\n";

$test = hb_call('POST', "/webhooks/{$endpoint['id']}/test", $token);
echo "{$test['message']} delivery {$test['delivery_id']}\n";

sleep(5);

$log = hb_call('GET', "/webhooks/{$endpoint['id']}/deliveries", $token);

foreach ($log['data'] as $delivery) {
    echo "{$delivery['id']} {$delivery['event_type']} {$delivery['status']} {$delivery['response_code']}\n";
}
```

### Python

```python
import os
import time

import requests

BASE = "https://hub.hbcompliance.co.uk/api/v2"


def call(method, path, token=None, json=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.request(method, f"{BASE}{path}", json=json, headers=headers, timeout=30)
    body = response.json()
    if response.status_code >= 400:
        raise RuntimeError(f"{body.get('error')}: {body.get('message')} (request {body.get('request_id')})")
    return body


token = call("POST", "/auth/token", json={"api_key": os.environ["HB_API_KEY"]})["access_token"]

endpoint = call(
    "POST",
    "/webhooks",
    token,
    {
        "name": "Rota system",
        "url": "https://example.com/hooks/hub",
        "events": ["online-training.course.completed", "occupational-health.request.full_clearance"],
    },
)
print("Endpoint", endpoint["id"], "- store this secret now:", endpoint["signing_secret"])

test = call("POST", f"/webhooks/{endpoint['id']}/test", token)
print(test["message"], "delivery", test["delivery_id"])

time.sleep(5)

for delivery in call("GET", f"/webhooks/{endpoint['id']}/deliveries", token)["data"]:
    print(delivery["id"], delivery["event_type"], delivery["status"], delivery["response_code"])
```

## Ordering and duplicates

Webhooks are delivered **at least once**, not exactly once, and not necessarily in order. A delivery that times out on your side after you have processed it will be sent again. Events can arrive out of order when an earlier one needs retries and a later one does not. Write your handler with that in mind:

- **Be idempotent.** Record each `event_id` you have processed, and when you see one again, answer `200` and do nothing. Keep the ids for at least as long as retries and redelivery could occur, which is days rather than minutes. A unique constraint on `event_id` in your database does the job well.
- **Do not rely on order.** Use `occurred_at` to ignore an event that is older than the state you already hold, or treat the event as a prompt and fetch the current state from the API, which is always right.
- **Keep the handler quick and safe to run twice.** Updating a record to a status is naturally repeatable. Adding one to a counter or sending an email is not, so guard those with the `event_id` check.
- **Expect events for things you did yourself.** If you assign a course through the API, you also get the `online-training.course.assigned` event. Use the `event_id` and your own records to avoid reacting twice.

## URL rules

When you save an endpoint, and again before every delivery, Hub checks the address:

- It must be a full `https://` address of at most 2048 characters. Plain `http` is refused.
- It must not contain a username or password (`https://user:pass@example.com/...`).
- The host must resolve to **public** internet addresses. Hub refuses addresses in private ranges (such as `10.x.x.x`, `172.16.x.x` to `172.31.x.x` and `192.168.x.x`) and in reserved ranges (such as `127.0.0.1` and link-local addresses), and hosts that do not resolve at all. This stops webhooks being pointed at internal networks. The check applies to every address the host resolves to.
- Redirects are not followed.

A refused address is a `422 validation_failed` with the problem on `url`, for example "The address must point to a public server." If an address that was fine when you saved it later points somewhere that fails the check, the delivery fails with that reason in the log.

This means you cannot receive webhooks on `localhost` directly. To test your handler on your own machine, run a tunnel that gives you a public https address, or test with the signed `curl` script above, or use the `test` call against a deployed staging server.

## Rotating the secret

Rotate the signing secret if it may have leaked, when someone who knew it leaves, or on a regular schedule. Call `POST /webhooks/{id}/rotate-secret`. The answer is the endpoint with a new `signing_secret`, shown once. The old secret stops being used at once: every delivery attempt after the call, including retries of older events, is signed with the new secret.

To rotate without losing events, make your verifier accept both secrets for a short time. First deploy a receiver that tries the new secret and, failing that, the old one. Then rotate, check that a test event verifies, and finally remove the old secret from your code. If you rotate first, deliveries that arrive before your new secret is in place will fail verification and will be retried, which is safe, but they will take longer to arrive.

## Checklist for a production receiver

- You verify the signature on the raw body, in constant time, with a timestamp tolerance.
- You answer `2xx` within a few seconds and do real work afterwards.
- You de-duplicate on `event_id`.
- You tolerate events out of order.
- Your endpoint has a public https address that is stable and monitored.
- You alert on failures. Watch `consecutive_failures` and `is_active` on the endpoint, so that you notice an endpoint before it reaches 25 and is switched off.
- You store the signing secret in a secret store, and you know how to rotate it.
