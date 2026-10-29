# Testing and the sandbox

> **The sandbox is available now, in the HB Developers portal.** The portal is a separate site from the Hub. You sign up there, create a sandbox, make a test key and call the sandbox with it. The portal guides explain every screen: start with [the portal overview](portal/01-overview.md) and [sandboxes](portal/06-sandboxes.md) (as resources, `hb://guides/portal-overview` and `hb://guides/portal-sandboxes`).

Testing an integration against live data is risky: a test booking can take a real seat, a test candidate can be emailed, and credits can be spent. The sandbox exists so that you can build and test everything first without any of that, and then go live by changing a base URL and a key.

## What the sandbox is

The sandbox is a separate environment that behaves like the Hub API but is not connected to the Hub. It is built and run by the HB Developers portal, and nothing you do in it touches Hub data. In particular:

- **It uses synthetic data only.** Each sandbox starts filled with made-up candidates, bookings and requests. Nothing in it is a real person.
- **It sends no emails or SMS.** Where the real API would email a candidate, the sandbox keeps the message in the portal's Inbox instead.
- **It costs nothing.** Credits and payments are pretend, and creating sandboxes is free.
- **It is stateful.** What you create in a sandbox stays there. A booking you make can be read back, changed and cancelled, as with the real API. Each sandbox has its own data.
- **It covers every portal at once**, with the same endpoints, scopes, validation, list format, pagination and errors as the real API. The sandbox is generated from the same OpenAPI specification as the documentation, which is how the two stay in step.
- **You can have several sandboxes** under one developer account (the portal shows the limit), for example one for development and one for your automated tests, and you can reset a sandbox back to its starting data. A reset also removes the webhook endpoints, delivery logs and inbox of that sandbox, so create the endpoints again afterwards. Your sandbox keys are kept.

### Test keys and base URLs

Test keys start with `hbk_test_` (that prefix followed by 40 random characters, 49 in all). Live keys start with `hbk_` and never with `hbk_test_` (that prefix followed by 48 random characters, 52 in all). A test key works only against its sandbox and a live key only against the live Hub, so the two cannot be confused.

The production API is at `https://hub.hbcompliance.co.uk/api/v2`. A sandbox is served from the developer portal's host, in one of two forms:

| Form | Base URL | Notes |
| --- | --- | --- |
| By sandbox id | `https://<developer-portal-host>/sandbox/<sandbox-id>/api/v2` | The address shown on the sandbox page in the portal. The sandbox is named in the path. |
| By key | `https://<developer-portal-host>/sandbox/api/v2` | The test key you exchange identifies the sandbox, so you can keep the same code and swap only the key. |

Both reach the same data. Copy the exact address from the sandbox page in the portal. If you use this MCP server, set `HB_BASE_URL` to the sandbox address (the part before `/api/v2` is enough, as with the live host) and `HB_API_KEY` to the test key.

Authentication is the same as in production. You call `POST /auth/token` with your test key, receive an access token and a refresh token in the same shape, and send the token as a bearer token. You choose scopes for a test key just as you do for a real one, so you can try out a least-privilege key before you create it for real. Code that works against one works against the other when you change only the base URL and the key. See [API keys and token exchange](portal/07-api-keys-and-tokens.md).

### Webhooks in the sandbox

You can create webhook endpoints in a sandbox, choose events, rotate the secret, see a delivery log and send a delivery again, as in production. Signatures use the same algorithm and the same headers as the real Hub, so the verification code in [webhooks](10-webhooks.md) works unchanged. The retry schedule and the automatic switch-off are the same as in production (five attempts, 25 failed deliveries in a row), with one difference for test events, described in [webhooks](10-webhooks.md). Only an https address that you registered is ever called.

Because real events depend on things people do (a candidate finishing a questionnaire, staff recording a clearance), an integration would not see its webhooks unless something happened. The portal therefore has **Simulate**: you run a simulation such as a candidate paying or an interview ending, and the sandbox changes as the real event would and sends the signed webhook events it raises. You can also send the example of any event to your endpoint from the webhooks page. See [simulate](portal/11-simulate.md) and the portal [webhooks](portal/09-webhooks.md) guide.

### Other tools in the portal

- **Request log.** Every call a sandbox answered, with both bodies, the error code and the request id. See [request log and debugging](portal/13-request-log-and-debugging.md).
- **Data page.** A read-only view of every table in a sandbox, so you can check what your calls changed. See [data page](portal/10-data-page-and-json-viewer.md).
- **API Playground.** Build and send requests from the console, and copy them as code. See [API Playground](portal/12-api-playground.md).
- **Inbox.** The emails and texts the sandbox would have sent.

If you need an error on demand, use real error cases: a missing scope, a bad body (`422`), an unknown id (`404`), or the rate limit. This guide does not describe any special fault headers or magic values, because the portal guides do not document them.

## Going from the sandbox to production

When your integration works in the sandbox, moving to production takes four changes, and nothing else in your code should need to change:

1. **Base URL.** Change it to `https://hub.hbcompliance.co.uk/api/v2`.
2. **API key.** Create a production key on the Hub Developer page with the minimum scopes your integration needs. See [getting started](01-getting-started.md) and [scopes](04-scopes-and-permissions.md).
3. **Webhook endpoints.** Register your endpoint again in production. It gets a new signing secret, so update your verifier's secret.
4. **Identifiers.** Candidate references, booking ids and other ids from the sandbox mean nothing in production. Do not copy them. Create or look up the real candidates through the production API.

Before you switch, work through the checklist in [going live](13-going-live.md).

## Testing safely against production

Prefer the sandbox. If you must test against production (for example to check your live key and network path just before going live), do it carefully. Part of the risk is that some calls have real effects. For instance:

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

The samples below choose the base URL from the key's prefix, so that a test key can never be sent to production by mistake and a production key cannot be sent to a sandbox. They also refuse to make write calls to production unless you opt in with `HB_ALLOW_PRODUCTION_WRITES=1`, which is a simple guard against running a test script against the live API by accident. Because each sandbox has its own address, a test key needs the sandbox base URL in `HB_SANDBOX_BASE_URL`, and the sample stops with a clear message if it is not set.

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
      throw new Error('This is a test key. Set HB_SANDBOX_BASE_URL to your sandbox base URL.');
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
            throw new RuntimeException('This is a test key. Set HB_SANDBOX_BASE_URL to your sandbox base URL.');
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
            raise RuntimeError("This is a test key. Set HB_SANDBOX_BASE_URL to your sandbox base URL.")
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
