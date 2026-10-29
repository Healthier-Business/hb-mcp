# Testing and the sandbox

> **The sandbox is coming with the developer portal and is not live yet.** It is being built as part of the HB Developers portal, which is a separate site from the Hub. Everything about the sandbox in this guide describes what is planned. When the sandbox opens, this guide will be updated with its address and exact details. Until then, use the careful approach to testing against production described in the second half of this guide.

Testing an integration against live data is risky: a test booking can take a real seat, a test candidate can be emailed, and credits can be spent. The sandbox exists so that you can build and test everything first without any of that, and then go live by changing a base URL and a key.

## What the sandbox will be

The sandbox is a separate environment that behaves like the Hub API but is not connected to the Hub. It is built and run by the HB Developers portal, and nothing you do in it touches Hub data. In particular:

- **It uses synthetic data only.** You get a sandbox filled with made-up candidates, bookings and requests. Nothing in it is a real person.
- **It sends no emails or SMS.** Where the real API would email a candidate, the sandbox does not send anything.
- **It has no real usage, limits or billing.** Spending credits or hitting an hourly limit does not cost you anything, and there is no cost for creating sandboxes.
- **It is stateful.** What you create in a sandbox stays there. A booking you make can be read back, changed and cancelled, as with the real API. Each sandbox has its own data.
- **It covers every portal at once**, with the same endpoints, scopes, validation, list format, pagination and errors as the real API. The sandbox is generated from the same OpenAPI specification as the documentation, which is how the two stay in step.
- **You can have as many sandboxes as you need** under one developer account, for example one for development and one for your automated tests, and you can reset a sandbox back to its starting data.

### Test keys and base URLs

Sandbox keys start with `hbk_test_`, so they can never be confused with production keys, which start with `hbk_`. Each sandbox has its own base URL. The production API is at `https://hub.hbcompliance.co.uk/api/v2`, and a sandbox is planned to answer at an address of the form `https://{sandbox}.sandbox.{domain}/api/v2`. The exact host will be shown in the developer portal when you create a sandbox. There will also be a shared address where the test key itself selects the sandbox.

Authentication is the same as in production. You call `POST /auth/token` with your test key, receive an access token and a refresh token in the same shape, and send the token as a bearer token. You choose scopes for a test key just as you do for a real one, so you can try out a least-privilege key before you create it for real. Code that works against one works against the other when you change only the base URL and the key.

If you give a test key an IP allowlist, the sandbox accepts and validates the list, but it checks it only if you switch enforcement on for that sandbox. That lets you test your handling of `403 ip_not_allowed` without locking yourself out by accident.

### Webhooks in the sandbox

You will be able to create webhook endpoints in a sandbox, choose events, rotate the secret, see a delivery log and redeliver, as in production. Signatures use the same algorithm and the same headers as the real Hub, so the verification code in [webhooks](10-webhooks.md) works unchanged.

Because real events depend on things people do (a candidate finishing a questionnaire, staff recording a clearance), a real integration cannot see its webhooks unless something happens. So the portal is planned to have a **simulate** panel. You pick an event, pick a record (or have one generated), edit the payload if you wish, and send it to your endpoint. Actions you take in the sandbox through the API, such as creating a booking or an occupational health request, produce the same events the real Hub would. There are also one-button simulators for things staff or candidates do in real life, such as advancing an occupational health request to full clearance, a candidate completing the questionnaire, marking a booking attended, issuing a certificate or expiring a renewal.

### Faults on demand

Good error handling needs errors, and real errors are hard to produce on demand. The sandbox is planned to let you ask for them:

- a delay header, `X-Sandbox-Delay`, to slow an answer down so that you can test your timeouts;
- a failure header, `X-Sandbox-Fail`, for example `X-Sandbox-Fail: 503`, to make a call fail with the status you name;
- magic values, such as a candidate named `Fail Candidate`, which is planned to return a `422`;
- a wallet set to zero, to produce `insufficient_credits`;
- a webhook endpoint that times out.

A "Testing" page in the developer portal will list the exact values and what each produces. Do not rely on any detail of these beyond what that page says when it is published.

### Other planned tools

The portal is also planned to include a viewer that shows the data in a sandbox in a layout similar to the Hub's own screens, a log of every API call and webhook delivery with the option to replay a call or copy it as a `curl` command, and a sandbox clock, which you can set to test things that depend on dates, such as renewals that fall due or bookings in the past.

## Going from the sandbox to production

When your integration works in the sandbox, moving to production takes four changes, and nothing else in your code should need to change:

1. **Base URL.** Change it to `https://hub.hbcompliance.co.uk/api/v2`.
2. **API key.** Create a production key on the Hub Developer page with the minimum scopes your integration needs. See [getting started](01-getting-started.md) and [scopes](04-scopes-and-permissions.md).
3. **Webhook endpoints.** Register your endpoint again in production. It gets a new signing secret, so update your verifier's secret.
4. **Identifiers.** Candidate references, booking ids and other ids from the sandbox mean nothing in production. Do not copy them. Create or look up the real candidates through the production API.

Before you switch, work through the checklist in [going live](13-going-live.md).

## Testing safely before the sandbox is open

Until the sandbox is available, you can still test responsibly against production, as long as you take care. Part of the risk is that some calls have real effects. For instance:

- creating a candidate emails them an activation link, unless you add them as inactive;
- assigning online training emails the candidate and may use credits;
- creating a booking takes a real seat and uses credits or balance, and sends confirmation emails;
- creating an occupational health request submits it to Healthier Business for processing and may use credits;
- creating a reference request emails the referees.

The following precautions keep your tests harmless.

- **Use a separate key for testing.** Give it only the scopes you are testing, an expiry date of a few days, and an IP allowlist of your own machine. Delete it when you finish.
- **Start with reads.** `GET` calls change nothing. `GET /auth/me`, the list endpoints and the catalogue endpoints (courses, clearance types, locations) let you build and test most of your code, including pagination, filtering, error handling and rate limit handling, with no side effects.
- **Test webhooks without real events.** `POST /webhooks/{id}/test` sends a `webhook.test` event to your endpoint, signed exactly like a real one, and changes nothing else. You can also replay a past event with the redeliver call. See [webhooks](10-webhooks.md).
- **Create test candidates as inactive.** `POST /hub/candidates` with `"is_active": false` adds the candidate without sending any email. Use an obviously fake name and an address you control, and make them inactive again or leave them inactive afterwards.
- **Use an address you control** for any email address, so that a message that is sent goes to you. Never use a real colleague's or patient's.
- **Read the portal's page before a write you cannot easily undo.** Each portal's page says what a write does, what it costs and whether it can be cancelled.
- **Use idempotency keys** when you test writes, so that a retry cannot create a second record. See [idempotency](07-idempotency.md).
- **Keep tests small and tell the people involved.** If your test touches a portal that Healthier Business staff process, such as Occupational Health, tell your account contact first, so that a test request is not treated as a real one.
- **Do not put real people in your tests**, and do not copy real health data into your test systems. See [health data and privacy](11-health-data-and-privacy.md).

### A client that knows which environment it is in

The samples below choose the base URL from the key's prefix, so that a test key can never be sent to production by mistake and a production key cannot be sent to a sandbox. They also refuse to make write calls to production unless you opt in with `HB_ALLOW_PRODUCTION_WRITES=1`, which is a simple guard against running a test script against the live API by accident. Because the sandbox address is not published yet, a test key needs the sandbox base URL in `HB_SANDBOX_BASE_URL`, and the sample stops with a clear message if it is not set.

### cURL

The only call that is both useful and harmless against production today is the webhook test. This sends a signed test event to one of your endpoints and shows the delivery log. Set `WEBHOOK_ID` to the id of an endpoint you created.

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'
WEBHOOK_ID="${WEBHOOK_ID:?Set WEBHOOK_ID to the id of your webhook endpoint}"

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

curl --silent --fail-with-body "$BASE/webhooks/$WEBHOOK_ID/test" \
  --request POST \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json'

sleep 5

curl --silent --fail-with-body "$BASE/webhooks/$WEBHOOK_ID/deliveries?per_page=5" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json' | jq '.data[] | {id, event_type, status, response_code}'
```

### JavaScript

```javascript
const PRODUCTION_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

export function resolveEnvironment(apiKey, env = process.env) {
  if (!apiKey) {
    throw new Error('Set HB_API_KEY.');
  }

  if (apiKey.startsWith('hbk_test_')) {
    if (!env.HB_SANDBOX_BASE_URL) {
      throw new Error('This is a test key. Set HB_SANDBOX_BASE_URL to your sandbox base URL (not published yet).');
    }

    return { name: 'sandbox', baseUrl: env.HB_SANDBOX_BASE_URL.replace(/\/$/, ''), allowWrites: true };
  }

  if (apiKey.startsWith('hbk_')) {
    return { name: 'production', baseUrl: PRODUCTION_BASE, allowWrites: env.HB_ALLOW_PRODUCTION_WRITES === '1' };
  }

  throw new Error('That does not look like an API key: keys start with hbk_.');
}

export async function call(environment, method, path, token, body) {
  if (method !== 'GET' && path !== '/auth/token' && path !== '/auth/refresh' && !environment.allowWrites) {
    throw new Error(`Refusing a ${method} to ${environment.name}. Set HB_ALLOW_PRODUCTION_WRITES=1 if you mean it.`);
  }

  const response = await fetch(`${environment.baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return { status: response.status, body: await response.json().catch(() => null) };
}

const environment = resolveEnvironment(process.env.HB_API_KEY);
console.log(`Using ${environment.name} at ${environment.baseUrl}`);

const token = await call(environment, 'POST', '/auth/token', null, { api_key: process.env.HB_API_KEY });
const me = await call(environment, 'GET', '/auth/me', token.body.access_token);
console.log(me.status, JSON.stringify(me.body));
```

### PHP

```php
<?php

const PRODUCTION_BASE = 'https://hub.hbcompliance.co.uk/api/v2';

/** @return array{name: string, baseUrl: string, allowWrites: bool} */
function resolve_environment(string $apiKey): array
{
    if ($apiKey === '') {
        throw new RuntimeException('Set HB_API_KEY.');
    }

    if (str_starts_with($apiKey, 'hbk_test_')) {
        $sandbox = (string) getenv('HB_SANDBOX_BASE_URL');

        if ($sandbox === '') {
            throw new RuntimeException('This is a test key. Set HB_SANDBOX_BASE_URL to your sandbox base URL (not published yet).');
        }

        return ['name' => 'sandbox', 'baseUrl' => rtrim($sandbox, '/'), 'allowWrites' => true];
    }

    if (str_starts_with($apiKey, 'hbk_')) {
        return ['name' => 'production', 'baseUrl' => PRODUCTION_BASE, 'allowWrites' => getenv('HB_ALLOW_PRODUCTION_WRITES') === '1'];
    }

    throw new RuntimeException('That does not look like an API key: keys start with hbk_.');
}

/** @param array{name: string, baseUrl: string, allowWrites: bool} $environment */
function hb_call(array $environment, string $method, string $path, ?string $token = null, ?array $json = null): array
{
    $isAuthCall = in_array($path, ['/auth/token', '/auth/refresh'], true);

    if ($method !== 'GET' && ! $isAuthCall && ! $environment['allowWrites']) {
        throw new RuntimeException("Refusing a {$method} to {$environment['name']}. Set HB_ALLOW_PRODUCTION_WRITES=1 if you mean it.");
    }

    $headers = ['Accept: application/json'];

    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
    }

    $curl = curl_init($environment['baseUrl'] . $path);
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

$apiKey = (string) getenv('HB_API_KEY');
$environment = resolve_environment($apiKey);
echo "Using {$environment['name']} at {$environment['baseUrl']}\n";

[, $token] = hb_call($environment, 'POST', '/auth/token', null, ['api_key' => $apiKey]);
[$status, $me] = hb_call($environment, 'GET', '/auth/me', $token['access_token']);
echo $status, ' ', json_encode($me), "\n";
```

### Python

```python
import os
import sys

import requests

PRODUCTION_BASE = "https://hub.hbcompliance.co.uk/api/v2"


def resolve_environment(api_key, env=os.environ):
    if not api_key:
        raise RuntimeError("Set HB_API_KEY.")

    if api_key.startswith("hbk_test_"):
        sandbox = env.get("HB_SANDBOX_BASE_URL")
        if not sandbox:
            raise RuntimeError("This is a test key. Set HB_SANDBOX_BASE_URL to your sandbox base URL (not published yet).")
        return {"name": "sandbox", "base_url": sandbox.rstrip("/"), "allow_writes": True}

    if api_key.startswith("hbk_"):
        return {"name": "production", "base_url": PRODUCTION_BASE, "allow_writes": env.get("HB_ALLOW_PRODUCTION_WRITES") == "1"}

    raise RuntimeError("That does not look like an API key: keys start with hbk_.")


def call(environment, method, path, token=None, json=None):
    is_auth_call = path in ("/auth/token", "/auth/refresh")
    if method != "GET" and not is_auth_call and not environment["allow_writes"]:
        raise RuntimeError(f"Refusing a {method} to {environment['name']}. Set HB_ALLOW_PRODUCTION_WRITES=1 if you mean it.")

    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, f"{environment['base_url']}{path}", json=json, headers=headers, timeout=30)


try:
    api_key = os.environ.get("HB_API_KEY")
    environment = resolve_environment(api_key)
except RuntimeError as error:
    sys.exit(str(error))

print(f"Using {environment['name']} at {environment['base_url']}")

token = call(environment, "POST", "/auth/token", json={"api_key": api_key}).json()["access_token"]
me = call(environment, "GET", "/auth/me", token)
print(me.status_code, me.text)
```

With a production key and no opt-in, these samples make only `GET` calls and the token exchange, so they are safe to run. With a test key they send everything to the sandbox address you supply.

## What to test before going live

Whatever environment you use, make sure your integration is tested against these situations. They are the ones that cause incidents in production.

- A token that expires in the middle of a run, and one that is refused. See [authentication](02-authentication.md).
- A `403 insufficient_scope` and a `403 ip_not_allowed`, handled as configuration errors and not retried.
- A `429` with `Retry-After`. See [rate limits](09-rate-limits.md).
- A `422` with `details` on one of your writes, shown to a person or logged with the `request_id`.
- A network failure and a `5xx` during a write, with the same `Idempotency-Key` on the retry.
- A duplicate webhook delivery, an out-of-order one, and one with a bad signature.
- A list with several pages, and an empty one.
