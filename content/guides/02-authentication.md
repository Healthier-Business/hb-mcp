# Authentication

The Hub API uses one authentication scheme for every portal. You exchange a long-lived API key for a short-lived access token, send the token with each request, and renew it when it runs out. There is one set of four endpoints for this, and every portal uses them. There are no separate sign-in endpoints inside the portals.

| Method and path | What it does | Needs a bearer token |
| --- | --- | --- |
| `POST /api/v2/auth/token` | Exchanges an API key for an access token and a refresh token | No |
| `POST /api/v2/auth/refresh` | Exchanges a refresh token for a new pair | No |
| `POST /api/v2/auth/revoke` | Ends the token pair you are using | Yes |
| `GET /api/v2/auth/me` | Shows the key behind the token and its scopes | Yes |

## The key and the tokens

A live **API key** starts with `hbk_` (never `hbk_test_`) and is 52 characters long. A sandbox **test key** starts with `hbk_test_` and works only in its sandbox (see [testing and sandbox](12-testing-and-sandbox.md)). You create it on the Developer page in the Hub (see [getting started](01-getting-started.md)). It is the root credential for your integration: it does not expire unless you gave it an expiry date, and it can mint as many tokens as it needs.

An **access token** is what you send on each call, in the header `Authorization: Bearer <access_token>`. It lasts 60 minutes (3600 seconds). A **refresh token** lasts 7 days (604800 seconds) and has one purpose: to get the next access token without presenting the key again.

The API issues both tokens as random 80-character strings and stores only a hash of each, so a token cannot be recovered later. If you lose one, get a new pair.

## Exchanging the key for a token

Send the key in a JSON body to `POST /auth/token`. The call needs no `Authorization` header.

```bash
curl --silent "https://hub.hbcompliance.co.uk/api/v2/auth/token" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}"
```

The answer is `200`:

```json
{
  "token_type": "Bearer",
  "access_token": "u8jzPde0IgxLd6GncfBAepfJBd0Kh8oOOL8dKLzdocJ2isAjIhKtJ0RlgLKOmxgJTeKdNnFRIBXuDL7D",
  "refresh_token": "xtpYlSXpfKtHF4vUCsMehGAkWvj7FAc9QeWJKY40uvSwMFLZDe1f8rESQedUStPKR0CsTy4Qwb8DwkNh",
  "expires_in": 3600,
  "refresh_expires_in": 604800
}
```

Each exchange creates a new pair and leaves any earlier pairs alone, so two processes can each hold their own tokens from the same key at the same time. The key itself is checked every time you exchange it: it must exist, be switched on, not be past its expiry date and, if it has an IP allowlist, be used from an allowed address. The failures are:

| Status | `error` | Meaning |
| --- | --- | --- |
| 401 | `invalid_credentials` | The key is unknown, has been deleted or has been regenerated |
| 403 | `key_inactive` | The key is switched off or has expired |
| 403 | `ip_not_allowed` | The key has an allowlist and your address is not on it |
| 422 | `validation_failed` | The `api_key` field was missing |
| 429 | `rate_limited` | More than 10 calls a minute (see below) |

## Using the access token

Send the access token on every other call:

```bash
curl --silent "https://hub.hbcompliance.co.uk/api/v2/auth/me" \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json'
```

`GET /auth/me` is a handy first test of a new key because it needs no scope. It shows the client the key belongs to, the key's name and prefix, its scopes and its expiry. Unlike most endpoints it returns its fields directly, not inside `data`:

```json
{
  "client_id": 1001,
  "key": {
    "name": "Rota system, production",
    "prefix": "hbk_kwXo",
    "scopes": ["hub:candidates:read", "online-training:candidates:write"],
    "expires_at": null
  }
}
```

The secret part of the key is never returned. Use `scopes` to check what a token can do if a call answers `403 insufficient_scope`.

## What is checked on every call

Authenticating once does not mean the API stops looking. On every call that carries a bearer token the API checks, in this order:

1. **The token.** It must exist, not be revoked and not have passed its 60 minutes. Otherwise the answer is `401 invalid_token`. A call with no bearer header at all is `401 unauthenticated`.
2. **The key is active.** If the key was switched off or has expired since the token was issued, the call is refused with `403 key_inactive` and the token is revoked.
3. **The IP allowlist.** If the key has one, the address you call from must be on it, otherwise `403 ip_not_allowed`. This is checked on every call, not just at the exchange, so editing the list takes effect immediately for tokens you already hold. See [IP allowlisting](05-ip-allowlisting.md).
4. **The rate limit.** The key has an hourly limit. When you are over it the answer is `429 rate_limited` with a `Retry-After` header. See [rate limits](09-rate-limits.md).
5. **The portal.** If the account does not use the portal in the path, the answer is `403 portal_unavailable`. The Hub core API is open to every key.
6. **The scope** the endpoint needs. If the key lacks it the answer is `403 insufficient_scope`, and the message names the scope. See [scopes and permissions](04-scopes-and-permissions.md).

The practical effect is that you can change a key in the Hub and the change applies at once: remove a scope, narrow the IP list or switch the key off, and tokens already in circulation obey the new rules on their next call. Regenerating or deleting a key revokes all of its tokens.

## Refreshing

Before the access token runs out, exchange the refresh token for a new pair:

```bash
curl --silent "https://hub.hbcompliance.co.uk/api/v2/auth/refresh" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data "{\"refresh_token\": \"$REFRESH_TOKEN\"}"
```

The answer has exactly the same shape as the token exchange. Two rules matter:

- **A refresh token works once.** The call revokes the refresh token you sent, and the answer holds a new one. Store the new refresh token straight away and discard the old one. Sending a token that was already used, has expired after its 7 days, or never existed answers `401 invalid_token`.
- **Each refresh starts a new 7 days.** The new pair gets a fresh lifetime, so an integration that refreshes at least once a week can run on one key without ever exchanging it again. If your integration sits idle for longer than that, exchange the key again.

The refresh call also checks the key: if the key has been switched off, has expired or is called from a disallowed address, you get `403 key_inactive` or `403 ip_not_allowed`. In that case the refresh token is not used up.

## Revoking

When a session ends, or if you think a token has leaked, revoke it. Send the access token in the header and no body:

```bash
curl --silent "https://hub.hbcompliance.co.uk/api/v2/auth/revoke" \
  --request POST \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --header 'Accept: application/json'
```

```json
{ "status": "revoked" }
```

Revoking ends the whole pair: both the access token and its refresh token stop working at once. It does not touch the key or any other pair. If the key itself may have leaked, do not stop at revoking tokens. Regenerate the key on the Developer page, which replaces the secret and revokes every token issued from the old one.

## Handling 401

A `401` has one of three causes, and the error code tells you which:

- `unauthenticated`: you sent no bearer token. This is a bug in your code.
- `invalid_token`: the access token is unknown, revoked or expired. The API does not tell an expired token from a revoked one. The right response is always the same: get a new token and retry the call once. Try the refresh token first, and if that also answers `401 invalid_token`, exchange the key.
- `invalid_credentials`: only on the token exchange. The key is wrong. Do not retry; fix the key.

Never loop forever on a `401`. Retry once with a fresh token, and if the second attempt fails as well, raise an error and look at the key.

## Concurrency pitfalls

Because a refresh token works once, two workers that share one token pair can trip over each other. Suppose two requests both notice at the same moment that the access token has expired. Both send the same refresh token. One succeeds and gets a new pair. The other is refused with `401 invalid_token`, because the token it sent has just been used. If the second worker then gives up, or worse, overwrites the shared store with nothing, your integration stops.

There are three ways to avoid this, and you can combine them:

1. **Serialise the refresh.** Within one process, make sure only one renewal runs at a time and let every waiting request use its result. Across processes, hold a lock (a file lock, a database row lock or a distributed lock) around "check, refresh, store".
2. **Fall back to the key.** If a refresh is refused with `401 invalid_token`, exchange the key for a new pair instead. Another worker may have won the race, and a new pair from the key is always valid.
3. **Give each worker its own pair.** The exchange creates independent pairs, so each worker or process can exchange the key for its own tokens and never share a refresh token. This is the simplest design for a handful of workers. Remember the exchange is limited to 10 calls a minute per address, so do not exchange the key on every request.

Also renew a little early, for example one minute before the access token expires, so a request is not sent with a token that expires in transit. And when a call is refused with `401 invalid_token`, renew only if the token that was refused is still the one you hold. If another request has already renewed it, use the new one. The helpers below do all of this.

## A reusable token manager

Each helper below keeps a token, renews it when needed, makes sure only one renewal runs at a time, retries once after a `401 invalid_token`, and falls back to the key if the refresh token is refused. Copy the one for your language and call `request` for everything else. Replace the base URL with your own if you test against a sandbox (see [testing and sandbox](12-testing-and-sandbox.md)).

### cURL

This is a small shell library that caches the pair in a file with owner-only permissions. It needs `curl` and `jq`. It is meant for scripts that run one at a time. It does not lock the file, so do not run several copies at once. Save it as `hb.sh` and `source` it.

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="${HB_BASE_URL:-https://hub.hbcompliance.co.uk/api/v2}"
STATE="${HB_TOKEN_FILE:-$HOME/.cache/hb-token.json}"
mkdir -p "$(dirname "$STATE")"

# Reads a token answer on stdin and saves it. Renews one minute early.
hb_store() {
  jq -e --argjson now "$(date +%s)" \
    'select(.access_token != null) | {access_token, refresh_token, access_expires_at: ($now + .expires_in - 60)}' \
    > "$STATE.tmp"
  chmod 600 "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}

hb_exchange() {
  curl --silent --fail-with-body "$BASE/auth/token" \
    --request POST --header 'Content-Type: application/json' --header 'Accept: application/json' \
    --data "$(jq --null-input --arg key "$HB_API_KEY" '{api_key: $key}')" | hb_store
}

hb_refresh() {
  curl --silent --fail-with-body "$BASE/auth/refresh" \
    --request POST --header 'Content-Type: application/json' --header 'Accept: application/json' \
    --data "$(jq --null-input --arg token "$(jq --raw-output .refresh_token "$STATE")" '{refresh_token: $token}')" | hb_store
}

# Prints a usable access token, renewing it when needed.
hb_access_token() {
  if [ -f "$STATE" ] && [ "$(jq --raw-output .access_expires_at "$STATE")" -gt "$(date +%s)" ]; then
    jq --raw-output .access_token "$STATE"
    return
  fi

  if [ -f "$STATE" ]; then
    hb_refresh 2>/dev/null || hb_exchange
  else
    hb_exchange
  fi

  jq --raw-output .access_token "$STATE"
}

# Usage: hb_get /hub/candidates?per_page=5
hb_get() {
  curl --silent --fail-with-body "$BASE$1" \
    --header "Authorization: Bearer $(hb_access_token)" \
    --header 'Accept: application/json'
}
```

To use it: `source hb.sh; hb_get '/hub/candidates?per_page=5'`. If a call answers `401 invalid_token` in the middle of a run, delete the state file and run the call again, which exchanges the key.

### JavaScript

Node 18 or later. Save it as `hub-client.mjs`. A renewal in progress is shared by every waiting call through one promise, so concurrent requests in the same process never refresh twice.

```javascript
const BASE = process.env.HB_BASE_URL ?? 'https://hub.hbcompliance.co.uk/api/v2';

export class HubError extends Error {
  constructor(status, body) {
    super(`${body?.error ?? 'error'}: ${body?.message ?? 'The request failed.'}`);
    this.status = status;
    this.code = body?.error ?? null;
    this.requestId = body?.request_id ?? null;
    this.details = body?.details ?? null;
  }
}

export class HubClient {
  #apiKey;
  #access = null;
  #refresh = null;
  #accessExpiresAt = 0;
  #renewal = null;

  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('An API key is required.');
    }
    this.#apiKey = apiKey;
  }

  async #post(path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  #store(token) {
    this.#access = token.access_token;
    this.#refresh = token.refresh_token;
    this.#accessExpiresAt = Date.now() + (token.expires_in - 60) * 1000;
  }

  async #renew() {
    if (this.#refresh) {
      const refreshed = await this.#post('/auth/refresh', { refresh_token: this.#refresh });
      if (refreshed.status === 200) {
        this.#store(refreshed.body);
        return;
      }
      if (refreshed.status !== 401) {
        throw new HubError(refreshed.status, refreshed.body);
      }
    }

    const exchanged = await this.#post('/auth/token', { api_key: this.#apiKey });
    if (exchanged.status !== 200) {
      throw new HubError(exchanged.status, exchanged.body);
    }
    this.#store(exchanged.body);
  }

  /** Returns a valid access token. Pass the token a call was refused with to force a renewal. */
  async accessToken(rejected = null) {
    if (rejected !== null && rejected === this.#access) {
      this.#accessExpiresAt = 0;
    }

    if (this.#access === null || Date.now() >= this.#accessExpiresAt) {
      this.#renewal ??= this.#renew().finally(() => {
        this.#renewal = null;
      });
      await this.#renewal;
    }

    return this.#access;
  }

  /** Calls the API and returns { status, headers, body }. It retries once after a 401 invalid_token. */
  async request(method, path, { query, body, headers = {} } = {}) {
    const url = new URL(`${BASE}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, String(value));
    }

    let rejected = null;

    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(rejected);
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);

      if (response.status === 401 && payload?.error === 'invalid_token' && attempt === 0) {
        rejected = token;
        continue;
      }

      return { status: response.status, headers: response.headers, body: payload };
    }
  }
}

// Example: run `HB_API_KEY=hbk_... node hub-client.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const hub = new HubClient(process.env.HB_API_KEY);
  const me = await hub.request('GET', '/auth/me');
  console.log(me.status, JSON.stringify(me.body, null, 2));
}
```

### PHP

This version keeps the pair in a file, so several PHP processes (for example PHP-FPM workers or cron jobs) share it safely. It takes an exclusive file lock around "check, refresh, store". Use a path outside your web root, and note that the file holds live tokens, so it is created readable by its owner only.

```php
<?php

final class HubTokenManager
{
    public function __construct(
        private string $apiKey,
        private string $storePath,
        private string $baseUrl = 'https://hub.hbcompliance.co.uk/api/v2',
    ) {
        if (! file_exists($this->storePath)) {
            touch($this->storePath);
            chmod($this->storePath, 0600);
        }
    }

    /** Returns a valid access token. Pass the token a call was refused with to force a renewal. */
    public function accessToken(?string $rejected = null): string
    {
        $handle = fopen($this->storePath, 'c+');

        if ($handle === false) {
            throw new RuntimeException('Cannot open the token store.');
        }

        try {
            flock($handle, LOCK_EX);
            $state = json_decode((string) stream_get_contents($handle), true);
            $state = is_array($state) ? $state : [];
            $isRejected = $rejected !== null && ($state['access_token'] ?? null) === $rejected;

            if (! $isRejected && isset($state['access_token']) && time() < ($state['access_expires_at'] ?? 0)) {
                return $state['access_token'];
            }

            $state = $this->renew($state);
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, json_encode($state));
            fflush($handle);

            return $state['access_token'];
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /**
     * Calls the API and returns [status, headers, body]. It retries once after a 401 invalid_token.
     *
     * @param array<string, mixed>|null $json
     * @param list<string> $headers
     * @return array{0: int, 1: array<string, string>, 2: mixed}
     */
    public function request(string $method, string $path, ?array $json = null, array $headers = []): array
    {
        $rejected = null;

        for ($attempt = 0; ; $attempt++) {
            $token = $this->accessToken($rejected);
            [$status, $responseHeaders, $body] = $this->send($method, $path, $token, $json, $headers);

            if ($status === 401 && ($body['error'] ?? null) === 'invalid_token' && $attempt === 0) {
                $rejected = $token;
                continue;
            }

            return [$status, $responseHeaders, $body];
        }
    }

    /**
     * @param array<string, mixed> $state
     * @return array<string, mixed>
     */
    private function renew(array $state): array
    {
        if (isset($state['refresh_token'])) {
            [$status, , $body] = $this->send('POST', '/auth/refresh', null, ['refresh_token' => $state['refresh_token']]);

            if ($status === 200) {
                return $this->toState($body);
            }

            if ($status !== 401) {
                throw new RuntimeException("Refresh failed: {$body['error']} (request {$body['request_id']})");
            }
        }

        [$status, , $body] = $this->send('POST', '/auth/token', null, ['api_key' => $this->apiKey]);

        if ($status !== 200) {
            throw new RuntimeException("Token exchange failed: {$body['error']} (request {$body['request_id']})");
        }

        return $this->toState($body);
    }

    /**
     * @param array<string, mixed> $token
     * @return array<string, mixed>
     */
    private function toState(array $token): array
    {
        return [
            'access_token' => $token['access_token'],
            'refresh_token' => $token['refresh_token'],
            'access_expires_at' => time() + $token['expires_in'] - 60,
        ];
    }

    /**
     * @param array<string, mixed>|null $json
     * @param list<string> $extraHeaders
     * @return array{0: int, 1: array<string, string>, 2: mixed}
     */
    private function send(string $method, string $path, ?string $token, ?array $json, array $extraHeaders = []): array
    {
        $responseHeaders = [];
        $headers = ['Accept: application/json', ...$extraHeaders];

        if ($token !== null) {
            $headers[] = 'Authorization: Bearer ' . $token;
        }

        if ($json !== null) {
            $headers[] = 'Content-Type: application/json';
        }

        $curl = curl_init($this->baseUrl . $path);
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

        return [$status, $responseHeaders, json_decode($raw, true)];
    }
}

// Example: HB_API_KEY=hbk_... php token-manager.php
$hub = new HubTokenManager((string) getenv('HB_API_KEY'), sys_get_temp_dir() . '/hb-token.json');
[$status, , $body] = $hub->request('GET', '/auth/me');
echo $status, ' ', json_encode($body, JSON_PRETTY_PRINT), "\n";
```

### Python

This uses `requests` and a lock, so threads in one process share one renewal. For several processes, give each its own client, which exchanges the key independently.

```python
import os
import threading
import time

import requests

BASE = os.environ.get("HB_BASE_URL", "https://hub.hbcompliance.co.uk/api/v2")


class HubError(Exception):
    def __init__(self, response):
        try:
            body = response.json()
        except ValueError:
            body = {}
        self.status = response.status_code
        self.code = body.get("error")
        self.request_id = body.get("request_id")
        self.details = body.get("details")
        super().__init__(f"{self.code}: {body.get('message', 'The request failed.')}")


class HubClient:
    def __init__(self, api_key, base_url=BASE):
        if not api_key:
            raise ValueError("An API key is required.")
        self._api_key = api_key
        self._base_url = base_url
        self._session = requests.Session()
        self._lock = threading.Lock()
        self._access = None
        self._refresh = None
        self._expires_at = 0.0

    def _post(self, path, body):
        return self._session.post(
            f"{self._base_url}{path}",
            json=body,
            headers={"Accept": "application/json"},
            timeout=30,
        )

    def _store(self, token):
        self._access = token["access_token"]
        self._refresh = token["refresh_token"]
        self._expires_at = time.time() + token["expires_in"] - 60

    def _renew(self):
        if self._refresh:
            refreshed = self._post("/auth/refresh", {"refresh_token": self._refresh})
            if refreshed.status_code == 200:
                self._store(refreshed.json())
                return
            if refreshed.status_code != 401:
                raise HubError(refreshed)

        exchanged = self._post("/auth/token", {"api_key": self._api_key})
        if exchanged.status_code != 200:
            raise HubError(exchanged)
        self._store(exchanged.json())

    def access_token(self, rejected=None):
        """Return a valid access token. Pass the token a call was refused with to force a renewal."""
        with self._lock:
            if rejected is not None and rejected == self._access:
                self._expires_at = 0.0
            if self._access is None or time.time() >= self._expires_at:
                self._renew()
            return self._access

    def request(self, method, path, params=None, json=None, headers=None):
        """Call the API and return the requests.Response. Retries once after a 401 invalid_token."""
        rejected = None
        for attempt in range(2):
            token = self.access_token(rejected)
            response = self._session.request(
                method,
                f"{self._base_url}{path}",
                params=params,
                json=json,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json", **(headers or {})},
                timeout=30,
            )
            if response.status_code == 401 and attempt == 0 and _error_code(response) == "invalid_token":
                rejected = token
                continue
            return response


def _error_code(response):
    try:
        return response.json().get("error")
    except ValueError:
        return None


if __name__ == "__main__":
    hub = HubClient(os.environ.get("HB_API_KEY"))
    me = hub.request("GET", "/auth/me")
    print(me.status_code, me.text)
```

## Rate limit on the auth endpoints

The token exchange and the refresh call are limited to 10 calls a minute. The limit is counted by your IP address, and for the token exchange also by the key you send. Over it, you get `429 rate_limited`. This is separate from the key's hourly limit, which applies to calls that carry a bearer token. Cache your tokens and refresh only when needed, and you will not come close. [Rate limits](09-rate-limits.md) has the details.

## Security advice

- **Keep the key on your server.** Never put it in a browser, a mobile app, a front-end bundle or a repository. If your front end needs data, have your back end call the API and pass on only what is needed.
- **Use one key per integration and per environment.** A key for production and another for testing means you can switch one off without breaking the other, and the Developer page shows which one was used last.
- **Give every key the fewest scopes that work.** See [scopes and permissions](04-scopes-and-permissions.md).
- **Set an expiry date** on keys that are meant to be temporary, such as a key for a contractor or a one-off migration. A key past its expiry is refused with `403 key_inactive`, and its tokens stop working.
- **Rotate keys on a schedule and whenever someone who knew a key leaves.** Regenerate the key on the Developer page, put the new one in your secret store, and the old one stops working at once.
- **Use an IP allowlist** if your calls come from fixed addresses. A stolen key is then useless from anywhere else. See [IP allowlisting](05-ip-allowlisting.md).
- **Never log keys or tokens.** Log the `request_id` from responses instead.
- **Store tokens as carefully as keys.** An access token is valid for an hour and a refresh token for a week. Keep them in memory or in a store only your service can read.
