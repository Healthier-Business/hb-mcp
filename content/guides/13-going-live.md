# Going live

Going live means pointing your integration at the production API with a real key, real candidates and real consequences. This guide gives you a checklist to work through first, explains the two ways of managing production keys, and describes the Developer role, which decides who in your organisation may do it.

If you have been using the sandbox, read [testing and sandbox](12-testing-and-sandbox.md) first. The sandbox is open in the HB Developers portal, so you can test there without touching production. Either way, the checklist below applies.

## The checklist

Work through these in order. Each item says why it matters and links to the guide that explains it.

### 1. A production key with the fewest scopes that work

Create a new key on the Developer page for production. Do not reuse a key you used for testing. Give it exactly the scopes your integration needs, and no wildcards, so that a mistake or a leak has limited effect. Give it a name that says what it is for, for example `Rota system, production`, so that you can recognise it later. Consider an expiry date, and put a reminder in your calendar to replace the key before it. See [scopes and permissions](04-scopes-and-permissions.md) and [getting started](01-getting-started.md).

### 2. An IP allowlist, if your calls come from fixed addresses

If your integration runs on servers with fixed public addresses, add them to the key. A stolen key is then useless anywhere else. Test both a call that should work and one that should be refused. If your hosting gives you no fixed address, rely on narrow scopes and an expiry date instead. See [IP allowlisting](05-ip-allowlisting.md).

### 3. The key lives in a secret store

The key must be in your secret store or in an environment variable on the server, not in your source code, your build output or a front end. Tokens too. Make sure your logs, error trackers and monitoring never record keys or tokens. See the security advice in [authentication](02-authentication.md).

### 4. Token handling is correct

Your code must cache the access token, renew it before it expires, handle a refused refresh by exchanging the key again, and make sure two workers do not break each other by refreshing the same refresh token. It should retry once after a `401 invalid_token`, and never loop on a `401`. The token manager in [authentication](02-authentication.md) does all of this.

### 5. A webhook endpoint with signature verification

If you use webhooks, register your production endpoint (the endpoint you used for testing has a different secret) and store its new signing secret. Your receiver must verify the signature on the raw body in constant time, check the timestamp, answer `2xx` quickly, and ignore an `event_id` it has seen. Send a test event and check that it arrives and verifies. See [webhooks](10-webhooks.md).

### 6. Idempotency on every write

Every call that creates something should carry an `Idempotency-Key` that you store with the operation, and your retry logic should reuse it. See [idempotency](07-idempotency.md).

### 7. Error handling and retries

Check that your code reads the `error` code and not the message, retries only what is safe (network failures, `429` after `Retry-After`, `5xx` with a growing pause), and does not retry `4xx` errors that need a human. See [errors](08-errors.md).

### 8. Rate limit awareness

Know your key's hourly limit, read `X-RateLimit-Remaining`, use `per_page=100`, cache reference data and prefer webhooks to polling. A new key allows 1,000 calls an hour. See [rate limits](09-rate-limits.md).

### 9. Monitoring and the `request_id`

Log the `request_id` of every error response (and the `X-Request-Id` header of other calls if you can), next to your own request identifier. When you contact support, it is the fastest way to have your call found. Set up alerts on:

- a rise in `401`, `403` and `5xx` answers;
- any `429`;
- your webhook receiver failing, and the `consecutive_failures` of your endpoint (see the preflight script below), so that you notice before an endpoint is switched off at 25;
- a key that has stopped being used, or one that is used when it should not be. The Developer page shows when each key was last used.

### 10. Data handling

If the integration touches occupational health, clinical, reference or training certificate data (a Training Verification certificate carries the candidate's name and training record), check that your handling follows your own data protection rules and that sensitive files and logs are protected. See [health data and privacy](11-health-data-and-privacy.md).

### 11. People and process

Decide who may create and change keys (the Developer role, below), where the key is stored, who is told if it must be rotated, and how often you will rotate it. Write down how to rotate a key and a webhook secret without downtime.

## A preflight script

The script below checks what it can from outside. It exchanges your production key, calls `GET /auth/me`, and reads your webhook endpoints, then prints what to fix. It checks that the key has no wildcard scope, that it has an expiry date, and that you have at least one active webhook endpoint with an https address and no recent failures. It cannot see the IP allowlist, so check that on the Developer page. The webhook checks need the scope `account:webhooks:read` and are skipped with a note if the key does not have it. The script makes only read calls.

### cURL

This needs `jq`. It prints each finding on a line starting `OK`, `WARN` or `FAIL`.

```bash
BASE='https://hub.hbcompliance.co.uk/api/v2'

ACCESS_TOKEN=$(curl --silent --fail-with-body "$BASE/auth/token" \
  --request POST --header 'Content-Type: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}" | jq --raw-output '.access_token')

ME=$(curl --silent --fail-with-body "$BASE/auth/me" \
  --header "Authorization: Bearer $ACCESS_TOKEN" --header 'Accept: application/json')

echo "$ME" | jq --raw-output '
  (if (.key.scopes | any(. == "*" or endswith(":*"))) then "WARN  The key has a wildcard scope: " + (.key.scopes | join(", ")) else "OK    No wildcard scopes" end),
  (if .key.expires_at == null then "WARN  The key has no expiry date" else "OK    The key expires " + .key.expires_at end)'

if HOOKS=$(curl --silent --fail-with-body "$BASE/webhooks?per_page=100" \
  --header "Authorization: Bearer $ACCESS_TOKEN" --header 'Accept: application/json'); then
  echo "$HOOKS" | jq --raw-output '
    (if (.data | map(select(.is_active)) | length) == 0 then "FAIL  No active webhook endpoint" else "OK    At least one active webhook endpoint" end),
    (.data[] | (if (.url | startswith("https://")) then "OK    " else "FAIL  " end) + "#" + (.id | tostring) + " " + .name + " uses " + .url),
    (.data[] | select(.consecutive_failures > 0) | "WARN  #" + (.id | tostring) + " " + .name + " has " + (.consecutive_failures | tostring) + " failed deliveries in a row"),
    (.data[] | select(.is_active | not) | "FAIL  #" + (.id | tostring) + " " + .name + " is switched off")'
else
  echo 'WARN  Could not read webhook endpoints (the key may lack account:webhooks:read)'
fi

echo 'NOTE  Check the IP allowlist on the Developer page: the API does not show it.'
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
  return { status: response.status, body: await response.json().catch(() => null) };
}

const exchange = await call('POST', '/auth/token', null, { api_key: process.env.HB_API_KEY });

if (exchange.status !== 200) {
  console.log(`FAIL  The key was not accepted: ${exchange.body?.error}`);
  process.exit(1);
}

const token = exchange.body.access_token;
const findings = [];

const me = await call('GET', '/auth/me', token);
const scopes = me.body.key.scopes;

findings.push(
  scopes.some((scope) => scope === '*' || scope.endsWith(':*'))
    ? `WARN  The key has a wildcard scope: ${scopes.join(', ')}`
    : 'OK    No wildcard scopes',
);
findings.push(
  me.body.key.expires_at === null ? 'WARN  The key has no expiry date' : `OK    The key expires ${me.body.key.expires_at}`,
);

const hooks = await call('GET', '/webhooks?per_page=100', token);

if (hooks.status === 200) {
  const endpoints = hooks.body.data;

  findings.push(
    endpoints.some((endpoint) => endpoint.is_active) ? 'OK    At least one active webhook endpoint' : 'FAIL  No active webhook endpoint',
  );

  for (const endpoint of endpoints) {
    findings.push(`${endpoint.url.startsWith('https://') ? 'OK   ' : 'FAIL '} #${endpoint.id} ${endpoint.name} uses ${endpoint.url}`);

    if (!endpoint.is_active) {
      findings.push(`FAIL  #${endpoint.id} ${endpoint.name} is switched off`);
    }

    if (endpoint.consecutive_failures > 0) {
      findings.push(`WARN  #${endpoint.id} ${endpoint.name} has ${endpoint.consecutive_failures} failed deliveries in a row`);
    }
  }
} else {
  findings.push(`WARN  Could not read webhook endpoints (${hooks.body?.error}); the key may lack account:webhooks:read`);
}

findings.push('NOTE  Check the IP allowlist on the Developer page: the API does not show it.');
console.log(findings.join('\n'));
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

[$status, $exchange] = hb_call('POST', '/auth/token', null, ['api_key' => (string) getenv('HB_API_KEY')]);

if ($status !== 200) {
    exit("FAIL  The key was not accepted: {$exchange['error']}\n");
}

$token = $exchange['access_token'];
$findings = [];

[, $me] = hb_call('GET', '/auth/me', $token);
$scopes = $me['key']['scopes'];
$hasWildcard = count(array_filter($scopes, fn (string $scope): bool => $scope === '*' || str_ends_with($scope, ':*'))) > 0;

$findings[] = $hasWildcard ? 'WARN  The key has a wildcard scope: ' . implode(', ', $scopes) : 'OK    No wildcard scopes';
$findings[] = $me['key']['expires_at'] === null ? 'WARN  The key has no expiry date' : "OK    The key expires {$me['key']['expires_at']}";

[$status, $hooks] = hb_call('GET', '/webhooks?per_page=100', $token);

if ($status === 200) {
    $endpoints = $hooks['data'];
    $anyActive = count(array_filter($endpoints, fn (array $endpoint): bool => $endpoint['is_active'])) > 0;
    $findings[] = $anyActive ? 'OK    At least one active webhook endpoint' : 'FAIL  No active webhook endpoint';

    foreach ($endpoints as $endpoint) {
        $label = "#{$endpoint['id']} {$endpoint['name']}";
        $findings[] = (str_starts_with($endpoint['url'], 'https://') ? 'OK    ' : 'FAIL  ') . "{$label} uses {$endpoint['url']}";

        if (! $endpoint['is_active']) {
            $findings[] = "FAIL  {$label} is switched off";
        }

        if ($endpoint['consecutive_failures'] > 0) {
            $findings[] = "WARN  {$label} has {$endpoint['consecutive_failures']} failed deliveries in a row";
        }
    }
} else {
    $findings[] = "WARN  Could not read webhook endpoints ({$hooks['error']}); the key may lack account:webhooks:read";
}

$findings[] = 'NOTE  Check the IP allowlist on the Developer page: the API does not show it.';
echo implode("\n", $findings), "\n";
```

### Python

```python
import os
import sys

import requests

BASE = "https://hub.hbcompliance.co.uk/api/v2"


def call(method, path, token=None, json=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, f"{BASE}{path}", json=json, headers=headers, timeout=30)


exchange = call("POST", "/auth/token", json={"api_key": os.environ["HB_API_KEY"]})
if exchange.status_code != 200:
    sys.exit(f"FAIL  The key was not accepted: {exchange.json().get('error')}")

token = exchange.json()["access_token"]
findings = []

key = call("GET", "/auth/me", token).json()["key"]
scopes = key["scopes"]

if any(scope == "*" or scope.endswith(":*") for scope in scopes):
    findings.append(f"WARN  The key has a wildcard scope: {', '.join(scopes)}")
else:
    findings.append("OK    No wildcard scopes")

findings.append("WARN  The key has no expiry date" if key["expires_at"] is None else f"OK    The key expires {key['expires_at']}")

hooks = call("GET", "/webhooks?per_page=100", token)

if hooks.status_code == 200:
    endpoints = hooks.json()["data"]
    findings.append(
        "OK    At least one active webhook endpoint"
        if any(endpoint["is_active"] for endpoint in endpoints)
        else "FAIL  No active webhook endpoint"
    )

    for endpoint in endpoints:
        label = f"#{endpoint['id']} {endpoint['name']}"
        findings.append(("OK    " if endpoint["url"].startswith("https://") else "FAIL  ") + f"{label} uses {endpoint['url']}")

        if not endpoint["is_active"]:
            findings.append(f"FAIL  {label} is switched off")

        if endpoint["consecutive_failures"] > 0:
            findings.append(f"WARN  {label} has {endpoint['consecutive_failures']} failed deliveries in a row")
else:
    findings.append(f"WARN  Could not read webhook endpoints ({hooks.json().get('error')}); the key may lack account:webhooks:read")

findings.append("NOTE  Check the IP allowlist on the Developer page: the API does not show it.")
print("\n".join(findings))
```

An example of the output, for a key with two scopes, an expiry date and one healthy endpoint:

```
OK    No wildcard scopes
OK    The key expires 2027-06-30T00:00:00Z
OK    At least one active webhook endpoint
OK    #7 Rota system uses https://example.com/hooks/hub
NOTE  Check the IP allowlist on the Developer page: the API does not show it.
```

## Two ways to manage production keys

You can manage your production keys and webhook endpoints in either of two ways. They end up in the same place: keys and endpoints that belong to your account in the Hub.

### Manually in the Hub

This is the way described in [getting started](01-getting-started.md). A person with the Developer permission signs in to the Hub, opens the Developer page and creates the keys and webhook endpoints, sets the IP allowlist, and copies the key and the webhook secret into your secret store. Nothing outside the Hub touches your production account. This is always available and is the simplest route for most teams.

### By connecting your HB Hub account to the developer portal

The HB Developers portal, where the sandbox lives, offers a second way. From the portal you choose **Connect HB Hub**, and the portal can then create and manage your production keys and webhooks for you, so you do not have to copy secrets between sites. If the portal tells you the connection is not set up for it, use the manual way. See [go to production](portal/16-go-to-production.md).

The connection uses OAuth 2, with the Hub as the provider. The steps are as follows:

1. In the developer portal, you choose **Connect HB Hub**. The portal sends you to the Hub's authorisation page.
2. You sign in to the Hub as you normally would, with two-factor authentication if you use it. The Hub checks that you hold the Developer permission. If you do not, you are told to ask your account owner for the Developer role, and you see no consent screen.
3. The Hub shows a consent screen that names the app and what it is asking for, every time. The app can ask only for three things: to see your account name and which portals are enabled, to create, change and delete your API keys, and to create, change and delete your webhook endpoints and read their deliveries. It cannot ask for anything else, and it cannot read your candidates or any portal data.
4. When you approve, the portal receives short-lived access (15 minutes) that it renews with a refresh token that lasts 30 days and is replaced each time it is used.

Important properties of the connection:

- **You stay in control.** On the Developer page, the **Connected apps** tab lists each app with who approved it, when, what it may do and when it was last used, and has a **Revoke** button that cuts the connection at once.
- **It follows the Developer role.** The Hub re-checks on every call that the person who approved still holds the Developer permission. If their role is removed, or they are removed from the team, the connection stops and its tokens are revoked.
- **Secrets are shown once.** A key's secret and a webhook's signing secret are shown only when they are created. The portal must not store them. They should be handed straight to you or into your own secret store.
- **Everything is logged.** Each action the portal takes on your behalf is recorded in the Hub's activity log against the person who approved the app, marked as done through an app.
- **It cannot do more than the Developer page.** The same rules apply to keys and webhooks created this way: the same scope choices, the IP allowlist limit of 20 entries, the expiry date rules and the webhook URL rules.

## The Developer role

Only some people in your organisation should be able to create keys and webhooks, because a key can reach your data. In the Hub that ability is the permission **Manage API keys and webhooks**.

The Owner, Administrator and Compliance Manager roles hold it by default. There is also a dedicated **Developer** role, which holds only that permission and nothing else. A Developer sees no candidates, reports, team, billing or portals, and when they sign in they land on the Developer page. It is meant for the people who build and run the integration, such as a contractor or an engineer in another department.

Your Owner or Administrator gives someone the role in **My Team**, either by changing an existing member's role or by inviting a new person with the Developer role. To take it away, change or remove the member. The person's access to the Developer page ends at once, and so does any connected app they approved. If they knew a key's secret, regenerate that key as well, because removing a role does not change keys.

Use the role sparingly. Everyone who holds it, and every connected app they approve, can create keys that read your candidates' data.

## After you go live

Going live is the start of running the integration, not the end. Keep an eye on your logs and alerts for the first few days. Check that your tokens refresh as planned across their first hour and their first week. Look at your webhook delivery logs for failures. Rotate the key and the webhook secret on the schedule you set. And read the [changelog](14-changelog-and-versioning.md) from time to time, so that you hear about additions and deprecations.
