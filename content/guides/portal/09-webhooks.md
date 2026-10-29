---
description: Register an https endpoint in a sandbox, choose events, keep the signing secret, verify every signature, test and simulate events, read the delivery log, and understand retries and automatic switch-off.
---
# Webhooks

A **webhook** is a request that Hub (here: your sandbox) sends **to you** when something happens, for example a booking is confirmed or a certificate is issued. It saves you from asking the API over and over whether anything changed.

The webhooks of the console are the same as `POST /api/v2/webhooks` (Create a webhook endpoint); the console is just a friendlier way to manage them and to read the delivery log. Webhooks belong to **one sandbox**.

## The Webhooks page

1. **Add webhook** registers an endpoint.
2. A row: name, address, number of **Events** it listens to, **Last delivery** (the answer code and how long ago) and **Status**.
3. **Status** is *Active*, or *Off* when you switched it off or Hub did after repeated failures.
4. **Event** filter: show only endpoints that listen to a certain event. **Status** filter: *Active*, *Failing* (25 or more failures in a row) or *Off*.

## Add a webhook

1. **Choose Add webhook**

2. **Fill in the fields**

   | Field | Rules |
   | --- | --- |
   | **Name** | Up to 100 characters. Say what receives it: *Bookings to our scheduler*. |
   | **Timeout (seconds)** | 5 to 30, default 10. How long Hub waits for your answer. |
   | **Address** | A full `https://` address of up to 2048 characters that resolves to a **public** server. No username or password in it. `http`, private network addresses (10.x, 192.168.x, localhost) and credentials are refused with *The address must be a full https:// address.* or *The address must point to a public server.* |
   | **Events** | At least one, grouped by portal. Choose a portal's checkbox to take all of its events. |
   | **Add webhook** | Registers the endpoint. |

3. **Copy the signing secret**

   You land on the endpoint page and the **signing secret** (`whsec_` followed by 48 characters) is shown **once**. Copy it into your secret store. It is also shown once more whenever you rotate it.

> **Warning: Hub does not follow redirects.**
>
> Give the **final** address. An answer of `301`/`302` counts as a failed delivery. Hub also checks the address again before every delivery, so an address that stops resolving to a public server stops receiving events.

## The endpoint page

Each endpoint has its own page with the delivery log, a **Try it** panel (**Send test event** and **Simulate an event**) and its settings, including the signing secret.

### The delivery log

Every event creates a **delivery**. The log shows the **Event** name, the **Status**, the **Attempt** (for example *2/5*), the **Answer** (HTTP status your server returned) and **When**. Search matches the event name and id; filters are **Status**, **Event** and **Sent** (a date range).

| Status | Meaning |
| --- | --- |
| Pending | Queued, not tried yet. |
| Retrying | The last attempt failed; another is scheduled. |
| Delivered | Your server answered with a 2xx status. |
| Failed | All attempts used, or the endpoint was off. |

Select a row to open the delivery:

An opened delivery shows the body that was sent as a JSON tree, and every attempt with its answer, time taken and the first part of your response.

### Retries

Answer any **2xx** status within the timeout to acknowledge an event. Anything else (a 4xx or 5xx status, a redirect, no answer) is retried: up to **5 attempts** in all, pausing **1 minute, 5 minutes, 15 minutes and 1 hour** before each retry. The log shows each attempt.

An endpoint that fails **25 deliveries in a row** is switched **off**. Fix the receiver, then switch it on again in **Settings**.

### Try it

* **Send test event** posts a `webhook.test` event to your address and tells you to look at the log. Test events are never retried and do not count as failures. The endpoint must be active (*The webhook is switched off. Switch it on to send a test event.* otherwise).
* **Simulate an event** sends the example of the event you pick, signed, to your address now, whether or not the endpoint listens to it. Its `candidate_ref` is replaced by a real candidate of your sandbox when the event has one. For events that need something to happen first, use [Simulate](hb://guides/portal-simulate) instead, which really changes the sandbox.
* In the delivery log, the row menu (three dots) has **View details** and **Send again**; the second sends the same event once more, with the same `event_id`.

### Settings and the signing secret

The console only ever shows the first characters of the secret (`whsec_...••••`). **Rotate secret** makes a new signing secret and shows it once; the old one stops working immediately. Update your receiver before you rotate, or accept both for a moment. In **Settings** you can change the name, address, events and timeout and choose **Save**; **Delete webhook** removes the endpoint.

## What a delivery looks like

Every delivery is a `POST` with a JSON body, the **envelope**:

```json
{
  "event_id": "7f659954-b5ea-429b-953a-a5725bcd5216",
  "event_type": "practical-training.booking.confirmed",
  "occurred_at": "2026-10-29T16:02:09Z",
  "data": {
    "booking_id": 812,
    "candidate_ref": "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
    "training_event_id": 44,
    "course_name": "Manual Handling"
  }
}
```

`data` holds ids, statuses, dates and a `candidate_ref`, **never** a name, an email address or health data: call the API with the `candidate_ref` to get more. The headers are:

| Header | Content |
| --- | --- |
| `X-Hub-Event` | The event name, e.g. `practical-training.booking.confirmed` |
| `X-Hub-Event-Id` | The same as `event_id` in the body; use it to ignore duplicates |
| `X-Hub-Delivery-Id` | The id of this delivery in the log |
| `X-Hub-Timestamp` | Unix time in seconds when the attempt was signed |
| `X-Hub-Signature` | `sha256=` followed by the HMAC-SHA256 signature |
| `User-Agent` | `HB-Sandbox-Webhooks/1` in a sandbox |

## Verify the signature

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`, written in hexadecimal and prefixed with `sha256=`. Compute it from the **raw bytes** you received (not from re-encoded JSON), compare in constant time, and reject old timestamps.

```php
$timestamp = $_SERVER['HTTP_X_HUB_TIMESTAMP'] ?? '';
$signature = $_SERVER['HTTP_X_HUB_SIGNATURE'] ?? '';
$body = file_get_contents('php://input');

$expected = 'sha256='.hash_hmac('sha256', $timestamp.'.'.$body, getenv('HB_WEBHOOK_SECRET'));

if (! hash_equals($expected, $signature) || abs(time() - (int) $timestamp) > 300) {
    http_response_code(400);
    exit;
}

http_response_code(200); // acknowledge first, process afterwards
```

```javascript
import crypto from 'node:crypto';

export function verify(rawBody, timestamp, signature, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
}
```

```python
import hmac, hashlib, time

def verify(raw_body: bytes, timestamp: str, signature: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature) and abs(time.time() - int(timestamp)) < 300
```

> **Tip: A receiver that survives retries.**
>
> 1. Verify the signature. 2. Answer `200` **immediately**. 3. Put the event on a queue and process it afterwards. 4. Ignore an `event_id` you have already handled: events can arrive twice (a retry after a slow answer, a redeliver).

## Problems

| In the log | Likely cause |
| --- | --- |
| *Could not connect to the receiver.* | The address is wrong, behind a firewall, or its certificate is invalid. |
| *The receiver did not answer in time.* | Your server took longer than the timeout. Answer first, work later. |
| *The receiver answered HTTP 500.* | Your handler threw. Check your logs with the `X-Hub-Delivery-Id`. |
| *The receiver redirected; redirects are not followed.* | Use the final address. |
| *The address must point to a public server.* | You used localhost or a private address. Use a tunnel or a public staging host. |

## Related

* [Simulate](hb://guides/portal-simulate)
* Create a webhook endpoint, Rotate the signing secret, Send a test event
* [Go to production](hb://guides/portal-go-to-production): register the production endpoint in HB Hub and store its new secret
