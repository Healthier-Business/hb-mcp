# Errors

When a call fails, the API tells you why in a body that always has the same shape, with a stable code your program can act on. This guide describes that shape, lists every error code the API can return, and explains what to do about each one and which are safe to retry.

## The error body

Every error from the `/api/v2` API, whatever the status, is JSON like this:

```json
{
  "error": "validation_failed",
  "message": "The email field must be a valid email address.",
  "details": {
    "email": ["The email field must be a valid email address."]
  },
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

| Field | Meaning |
| --- | --- |
| `error` | A short code in `snake_case`. It is stable and is the thing your code should test |
| `message` | A sentence for a person. It may be reworded, so never parse it or compare it with a string |
| `details` | Present only when there is something to point at. For `422`, it maps each field name to a list of messages. Some portal errors put structured information here instead |
| `request_id` | A 26-character identifier for this call, also sent as the `X-Request-Id` response header |

Some errors add further top-level fields. A `402 payment_required` has a `payment_url`, for instance, and a Practical Training hold conflict has a `hold` object. Those are described in the table below and on each portal's page.

An error never contains an exception message, a class name, a file path, a database query or a stack trace. If something unexpected goes wrong on our side you get `500 server_error` with a generic message and the `request_id`.

Every v2 response, successful ones included, carries the `X-Request-Id` header. Log it next to your own request log.

## Never parse the message

The `error` code is the contract. The `message` is human-readable text that we may improve, translate or reword without notice, and it often contains values such as scope names or limits. Write `if (error.code === 'insufficient_scope')`, not `if (error.message.includes('scope'))`. For `422`, take field names from the keys of `details`, which are the names of your request fields, and show the messages to your own users if you wish.

## What to send to support

If you need help with a failed call, send us:

- the `request_id` (from the body or the `X-Request-Id` header). It lets us find the call in our logs, so it is the most useful single piece of information;
- the date and time (with time zone), the method and the path;
- the HTTP status and the `error` code.

Do not send your API key, an access token or a refresh token. We never need them and you should not email secrets. If you think a secret has been exposed, regenerate the key on the Developer page.

## Every error code

This table covers every code the API can return. Codes in the first group can come from any endpoint. Codes in the later groups belong to particular portals.

### Errors that can come from any endpoint

| Status | `error` | When it happens | What to do |
| --- | --- | --- | --- |
| 400 | `bad_request` | A body that says it is JSON does not parse | Fix the body. Do not retry unchanged |
| 401 | `unauthenticated` | There is no bearer token on a call that needs one | Send `Authorization: Bearer <access_token>` |
| 401 | `invalid_token` | The access token or refresh token is unknown, revoked or expired | Renew the token and retry once. See [authentication](02-authentication.md) |
| 401 | `invalid_credentials` | On `POST /auth/token`, the API key is unknown, deleted or regenerated | Check the key. Do not retry |
| 403 | `key_inactive` | The key has been switched off or has expired | Switch it on or create a new key on the Developer page |
| 403 | `ip_not_allowed` | The key has an IP allowlist and your address is not on it | Fix the allowlist or the calling address. See [IP allowlisting](05-ip-allowlisting.md) |
| 403 | `portal_unavailable` | Your account does not use the portal in the path | Ask to have the portal enabled. A scope will not fix this |
| 403 | `insufficient_scope` | The key lacks the scope the endpoint needs. The message names it | Add the scope to the key. See [scopes](04-scopes-and-permissions.md) |
| 403 | `forbidden` | The action is not allowed for another reason | Read the message. Do not retry |
| 404 | `not_found` | The route, record or candidate does not exist, or belongs to another client. These cases are deliberately indistinguishable | Check the id or `candidate_ref` and the key |
| 405 | `method_not_allowed` | Wrong HTTP method for the path. The `Allow` header lists the right ones | Use a listed method |
| 409 | `conflict` | The request clashes with the current state (for example a place is already held, or a booking cannot be cancelled in its state) | Read the message and the state. Retry only after the state changes |
| 409 | `idempotency_conflict` | The same `Idempotency-Key` was used with different content | Use a new key for a different request. See [idempotency](07-idempotency.md) |
| 413 | `payload_too_large` | The body is bigger than the server accepts | Send less data or split the upload |
| 415 | `unsupported_media_type` | The body is not JSON, `application/x-www-form-urlencoded` or `multipart/form-data` | Send `Content-Type: application/json` |
| 422 | `validation_failed` | A field is missing or invalid. `details` is `{ "field": ["message"] }`. Also used for a bad `page`, `per_page`, `sort`, filter or a too-long `Idempotency-Key` | Correct the fields named in `details` |
| 429 | `rate_limited` | Over the key's hourly limit, a route's per-minute throttle, or the 10-a-minute limit on the auth endpoints | Wait for `Retry-After` seconds, then retry. See [rate limits](09-rate-limits.md) |
| 500 | `server_error` | Something unexpected went wrong on our side | Retry after a pause. If it persists, contact support with the `request_id` |
| 503 | `service_unavailable` | Maintenance or an unavailable dependency. `Retry-After` is set when known | Retry after a pause or after `Retry-After` |

A few further HTTP statuses may appear in unusual circumstances, such as a gateway problem in front of the API. They use the snake case of the status text as the code: `406 not_acceptable`, `408 request_timeout`, `410 gone`, `501 not_implemented`, `502 bad_gateway` and `504 gateway_timeout`. Treat `502`, `503` and `504` like `500`.

### Credits and payment

| Status | `error` | When it happens | What to do |
| --- | --- | --- | --- |
| 402 | `insufficient_credits` | The call needs more credits or balance than you have. The shape depends on the portal. **Online Training** (`PUT /candidates/{candidate_ref}/courses`, when the account charges at assignment): the amounts are inside `details`, `{ "error": "insufficient_credits", "message": "...", "details": { "needed": 3, "available": 1 }, "request_id": "..." }`, in credits. **Practical Training** (a booking paid with `credits` or `balance`, and creating a booking invitation): there is no `details`; the body has a top-level `available` object, `{ "error": "insufficient_credits", "message": "...", "available": { "pays_with": "credits", "balance_pence": 0, "credits": 0, "price_pence": 6000 }, "request_id": "..." }` (`price_pence` is there for a booking, not for an invitation) | Top up in the Hub, then retry. Do not retry unchanged |
| 402 | `payment_required` | A Virtual BLS reschedule inside the late-change window needs a payment. The body has a top-level `payment_url`, `{ "error": "payment_required", "message": "...", "payment_url": "https://...", "request_id": "..." }`, and no `details` | Send the candidate to `payment_url` |

### Practical Training and Virtual BLS Training

| Status | `error` | When it happens | What to do |
| --- | --- | --- | --- |
| 403 | `invites_not_enabled` | Booking invitations are not switched on for the account (Practical Training) | Ask to have invitations enabled |
| 409 | `conflict` | You already hold a place, and the body has a `hold` object describing it. Also: a booking that cannot be cancelled (it is not confirmed, or its session has started) or has no certificate yet | Use or release the held place first |
| 422 | `no_places_left` | The session is full (Practical Training hold or booking) | Choose another session |
| 422 | `booking_rejected` | The booking or hold was refused. The message gives the reason, such as invoicing that is not allowed, a session that is no longer open or a candidate already booked | Read the message, adjust the request |
| 503 | `service_unavailable` | A Practical Training cancellation is due a card refund and the payment provider could not make it. The booking was not cancelled | Retry after a pause |

### Clinical Interviews and Clinical Appraisals

| Status | `error` | When it happens | What to do |
| --- | --- | --- | --- |
| 403 | `client_restricted` | The account is restricted from this action (Clinical Interviews) | Contact support |
| 403 | `blocked` | A slot hold was refused by the abuse limits (Clinical Interviews) | Contact support if you think this is wrong |
| 409 | `hold_exists` | You already hold a slot. The existing hold is in `details` | Use or release it first |
| 409 | `slot_taken` | The time was taken by someone else | Choose another time |
| 410 | `report_expired` | The interview outcome PDF is past its retention period | It is no longer available |
| 422 | `hold_refused` | The slot hold was refused. The message gives the reason | Read the message |
| 422 | `booking_refused` | The booking was refused (Clinical Interviews and Appraisals) | Read the message |
| 422 | `cancel_refused` | The cancellation rules refuse it (Clinical Interviews) | Read the message |
| 422 | `reschedule_refused`, `late_reschedule_not_allowed` | The reschedule is refused, or is too close to the start (Clinical Interviews) | Read the message |
| 422 | `report_not_available` | The interview report or evaluation report is not ready yet | Try again after the interview or appraisal is completed |
| 428 | `human_check` | A slot hold needs a human check first (abuse limits) | Do not automate around it. Contact support |
| 429 | `too_fast`, `client_limit`, `ip_limit` | A slot hold was refused by the abuse limits (too fast, or too many holds from the account or address) | Slow down and retry later |

### Online Training

| Status | `error` | When it happens | What to do |
| --- | --- | --- | --- |
| 422 | `no_certificates` | A certificate request matches no completed course | Change the certificate `type` or filters |

### References

| Status | `error` | When it happens | What to do |
| --- | --- | --- | --- |
| 404 | `pdf_not_available` | No PDF exists for the reference | Wait until the reference is submitted |
| 422 | `reference_request_refused` | The reference request could not be created or changed. The message gives the reason | Read the message |
| 409 | `request_not_cancellable` | The request is `completed` or already `cancelled` | Nothing to do; read the request |
| 409 | `request_not_extendable` | The request is `completed` or `cancelled` | Create a new request |
| 409 | `request_not_open` | A referee cannot be added: the request is completed, cancelled, expired or past its expiry | Extend an expired request first, or create a new one |
| 409 | `referee_already_added` | A referee with this email address (not declined, expired or bounced) is already on the request | Use another address or leave it |
| 409 | `referee_limit_reached` | The request already has the most referees allowed (10) who have not declined, expired or bounced | Wait for a replacement to be needed |
| 409 | `legacy_request_unanswered` | An imported legacy request nobody answered cannot be extended or given referees through the API | Contact support |
| 409 | `reminder_not_sent` | No reminder was sent, for example because the next one is not due yet or the referee cannot be chased now | Read the message; retry after the date it gives |

### Registration Monitoring and DBS and Right To Work

| Status | `error` | When it happens | What to do |
| --- | --- | --- | --- |
| 422 | `verification_refused` | A re-check was refused. For a batch, `details.refused` lists which workers were refused and why | Read the message and `details` |
| 422 | `no_active_workers` | A batch re-check found no active workers | Check the worker ids and their status |
| 422 | `too_many_workers` | A batch holds more workers than the limit. The message gives it | Send smaller batches |
| 422 | `workers_not_found` | One or more worker ids do not belong to the account | Check the ids |
| 422 | `invalid_track`, `track_required` | A DBS and Right To Work re-check needs `track` to be `dbs` or `rtw` | Send a valid `track` |
| 422 | `not_share_code_worker` | You changed a share code for a worker not monitored with a share code | Use only for share-code workers |

### Webhooks

| Status | `error` | When it happens | What to do |
| --- | --- | --- | --- |
| 422 | `webhook_inactive` | You sent a test event to an endpoint that is switched off | Switch it on with `PUT /webhooks/{id}` and `is_active: true` |

## Retry guidance

Whether a retry is safe depends on the error, and on whether the call writes.

| Group | Codes | Retry? |
| --- | --- | --- |
| Your request is wrong | `400`, `404`, `405`, `409` (except as below), `413`, `415`, `422`, and the portal `422` codes | No. Change the request first |
| Authorisation | `401 unauthenticated`, `401 invalid_credentials`, `403 *` | No. These need a person to change a key, scope or setting |
| Token expired | `401 invalid_token` | Yes, once, after renewing the token |
| Too many requests | `429 rate_limited` | Yes, after `Retry-After` seconds |
| Server trouble | `500`, `502`, `503`, `504` | Yes, with a growing pause and a limit of a few attempts |
| State conflict | `409 conflict`, `slot_taken`, `hold_exists` | Only after the state changes, such as releasing a hold |
| Credits | `402` | Only after you add credits |
| Network failure | no response at all | Yes, and send an `Idempotency-Key` on creating calls so that the retry cannot duplicate |

Reads (`GET`) are always safe to retry. For writes, follow the strategy in [idempotency](07-idempotency.md): reuse the same `Idempotency-Key` and the same body on a retry.

## Handling 429

A `429` carries a `Retry-After` header holding the number of seconds to wait, and the `X-RateLimit-*` headers. Sleep for that long and try again. Do not retry immediately, and do not retry in a tight loop. Details, including the difference between the hourly limit and the per-minute throttles, are in [rate limits](09-rate-limits.md).

```json
{
  "error": "rate_limited",
  "message": "Too many requests.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

## Examples of error bodies

An unknown candidate in a path (`GET /hub/candidates/{candidate_ref}` for a reference that is not yours):

```json
{
  "error": "not_found",
  "message": "The candidate was not found.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

A missing scope:

```json
{
  "error": "insufficient_scope",
  "message": "The API key lacks the [hub:candidates:write] scope.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

A bad `sort` on a list:

```json
{
  "error": "validation_failed",
  "message": "The sort must be one of: name, email, added_at, updated_at (prefix with - for descending).",
  "details": { "sort": ["The sort must be one of: name, email, added_at, updated_at (prefix with - for descending)."] },
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

An Online Training assignment that cannot be paid:

```json
{
  "error": "insufficient_credits",
  "message": "Not enough credits to assign these courses.",
  "details": { "needed": 3, "available": 1 },
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

The exact wording of messages in these examples is illustrative, and may differ from what you see. The codes and the fields are the contract.

## An error-handling helper

The samples below turn any answer into either data or a typed error, decide what to do with it from the status and code alone, and print the `request_id`. They deliberately cause a `422` by asking for `per_page=500`, so you can see the error come back. Each one reads your key from `HB_API_KEY`.

### cURL

This prints the status, the `X-Request-Id` header and the error body of a deliberately invalid call.

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

curl --silent --include "$BASE/hub/candidates?per_page=500" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json' | grep -i -E '^(HTTP/|x-request-id|\{)'
```

### JavaScript

```javascript
const BASE = 'https://hub.hbcompliance.co.uk/api/v2';

export class HubError extends Error {
  constructor(status, body, headers) {
    super(`${body?.error ?? 'error'}: ${body?.message ?? 'The request failed.'}`);
    this.status = status;
    this.code = body?.error ?? null;
    this.details = body?.details ?? null;
    this.requestId = body?.request_id ?? headers.get('x-request-id');
    this.retryAfter = headers.has('retry-after') ? Number(headers.get('retry-after')) : null;
  }
}

/** What to do about an error: 'renew-token', 'wait', 'retry', 'fix' or 'stop'. */
export function nextStep(error) {
  if (error.status === 401 && error.code === 'invalid_token') return 'renew-token';
  if (error.status === 429) return 'wait';
  if ([500, 502, 503, 504].includes(error.status)) return 'retry';
  if (error.status === 422 || error.status === 400) return 'fix';
  return 'stop';
}

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
    throw new HubError(response.status, payload, response.headers);
  }

  return payload;
}

const { access_token: token } = await call('POST', '/auth/token', null, { api_key: process.env.HB_API_KEY });

try {
  await call('GET', '/hub/candidates?per_page=500', token);
} catch (error) {
  if (!(error instanceof HubError)) {
    throw error;
  }
  console.log(`status ${error.status}, code ${error.code}, next step: ${nextStep(error)}`);
  console.log('request id:', error.requestId);
  console.log('field problems:', JSON.stringify(error.details));
}
```

### PHP

```php
<?php

const HB_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

final class HubError extends RuntimeException
{
    /** @param array<string, mixed>|null $body */
    public function __construct(
        public readonly int $status,
        public readonly ?array $body,
        public readonly ?string $requestId,
        public readonly ?int $retryAfter,
    ) {
        parent::__construct(($body['error'] ?? 'error') . ': ' . ($body['message'] ?? 'The request failed.'));
    }

    public function errorCode(): ?string
    {
        return $this->body['error'] ?? null;
    }

    /** What to do about the error: renew-token, wait, retry, fix or stop. */
    public function nextStep(): string
    {
        return match (true) {
            $this->status === 401 && $this->errorCode() === 'invalid_token' => 'renew-token',
            $this->status === 429 => 'wait',
            in_array($this->status, [500, 502, 503, 504], true) => 'retry',
            in_array($this->status, [400, 422], true) => 'fix',
            default => 'stop',
        };
    }
}

/** @return array<string, mixed> */
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
    $body = json_decode($raw, true);

    if ($status >= 400) {
        $retryAfter = isset($responseHeaders['retry-after']) ? (int) $responseHeaders['retry-after'] : null;

        throw new HubError($status, is_array($body) ? $body : null, $body['request_id'] ?? $responseHeaders['x-request-id'] ?? null, $retryAfter);
    }

    return $body;
}

$token = hb_call('POST', '/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')])['access_token'];

try {
    hb_call('GET', '/hub/candidates?per_page=500', $token);
} catch (HubError $error) {
    echo "status {$error->status}, code {$error->errorCode()}, next step: {$error->nextStep()}\n";
    echo "request id: {$error->requestId}\n";
    echo 'field problems: ', json_encode($error->body['details'] ?? null), "\n";
}
```

### Python

```python
import os

import requests

BASE = "https://hub.hbcompliance.co.uk/api/v2"


class HubError(Exception):
    def __init__(self, response):
        try:
            body = response.json()
        except ValueError:
            body = {}
        self.status = response.status_code
        self.code = body.get("error")
        self.details = body.get("details")
        self.request_id = body.get("request_id") or response.headers.get("X-Request-Id")
        retry_after = response.headers.get("Retry-After")
        self.retry_after = int(retry_after) if retry_after and retry_after.isdigit() else None
        super().__init__(f"{self.code}: {body.get('message', 'The request failed.')}")

    def next_step(self):
        """What to do about the error: renew-token, wait, retry, fix or stop."""
        if self.status == 401 and self.code == "invalid_token":
            return "renew-token"
        if self.status == 429:
            return "wait"
        if self.status in (500, 502, 503, 504):
            return "retry"
        if self.status in (400, 422):
            return "fix"
        return "stop"


def call(method, path, token=None, json=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.request(method, f"{BASE}{path}", json=json, headers=headers, timeout=30)
    if response.status_code >= 400:
        raise HubError(response)
    return response.json()


token = call("POST", "/auth/token", json={"api_key": os.environ["HB_API_KEY"]})["access_token"]

try:
    call("GET", "/hub/candidates?per_page=500", token)
except HubError as error:
    print(f"status {error.status}, code {error.code}, next step: {error.next_step()}")
    print("request id:", error.request_id)
    print("field problems:", error.details)
```

All three print `status 422, code validation_failed, next step: fix`, the request id, and the `per_page` problem in the field details.
