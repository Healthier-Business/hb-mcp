# Developer management API (OAuth)

The API the HB Developers portal (pactyard) uses, on behalf of one Hub user, to manage a client's **production** API keys and webhook endpoints. It is **not** the public client API: it is not reachable with an API key, it is internal to HB Developers, and it is tagged `Developer management` (OAuth security scheme) apart from the `/api/v2` documentation. Design and decisions: `../05-hub-oauth-sso-and-go-live.md`.

Base URL: `https://{hub host}/api/oauth/developer`. It is not part of the generated OpenAPI document (which describes `/api/v2` only), so this page is its reference. Every answer follows the v2 standards (`{ data }` envelope, lists with `meta` and `links`, ISO 8601 UTC dates with `Z`, the one error shape with `request_id` and an `X-Request-Id` header).

## 1. Connecting (OAuth 2, authorization code with PKCE)

Pactyard is a **confidential client**. Hub gives it a client id and secret once (`php artisan hub:oauth:create-developer-portal-client --redirect=...`).

1. Send the developer's browser to `GET {hub}/oauth/authorize` with `client_id`, `redirect_uri` (must equal a registered URI exactly), `response_type=code`, `scope` (space separated, any of the three below), `state`, `code_challenge` and `code_challenge_method=S256`. **PKCE with S256 is required** (a request without it is a 400 `invalid_request`), and only the three developer scopes are accepted (400 `invalid_scope`).
2. The developer signs in to Hub with their normal Hub sign-in (including two-factor where set). Hub requires a **client user holding the Developer permission** (Developer role, Owner, Administrator, Compliance Manager). Anyone else sees "Ask your account owner to give you the Developer role" (HTTP 403) and no consent screen.
3. Hub shows the consent screen (the app name and the requested scopes). It is shown on every connection, also for an app approved before. On approval Hub redirects to `redirect_uri?code=...&state=...`; on cancel, with `error=access_denied`.
4. Exchange the code: `POST {hub}/oauth/token` (form fields) `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code`, `code_verifier`. Answer: `{ token_type: "Bearer", expires_in: 900, access_token, refresh_token }`.
5. Refresh: `POST {hub}/oauth/token` with `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`. Refresh tokens **rotate**: each use returns a new pair and the old pair stops working (reusing an old refresh token is a 400 `invalid_grant`). A refresh token lasts 30 days; an access token 15 minutes.
6. No other grant works on the token endpoint (client credentials, password, implicit and device are refused).

Disconnect from pactyard: `DELETE /api/oauth/developer/connection` (below). The client can also revoke the connection from the Developer page in Hub ("Connected apps").

## 2. Scopes

| Scope | Allows |
| --- | --- |
| `developer:profile` | `GET client`, `GET portals`, `DELETE connection` |
| `developer:keys` | every `keys` endpoint |
| `developer:webhooks` | every `webhooks` endpoint |

A call without the scope is a 403 `insufficient_scope`.

## 3. Checks on every call

Hub checks on **every** call, not only when the token was issued, that the user still is a client user, is not disabled or removed and still holds the Developer permission. If not, the call is a 403 `developer_role_required` ("Ask your account owner to give you the Developer role. The connection has been switched off.") and **all of the user's OAuth tokens are revoked** (also when a Hub administrator moves or removes the user from My Team: the tokens are revoked there too). The user is always the person who approved the connection; every key and webhook is scoped to that user's Hub client (`hb_client_id`), so a token never sees another client's data (an id of another client is a 404).

Rate limit: 120 calls a minute per access token (429 `rate_limited` with `Retry-After`).

## 4. Errors

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | A JSON body that does not parse |
| 401 | `unauthenticated` | No bearer token |
| 401 | `invalid_token` | Token invalid, expired, revoked, or the user no longer exists. An API key or API token is never accepted here |
| 403 | `developer_role_required` | The user lost the Developer permission (connection revoked) |
| 403 | `insufficient_scope` | The token lacks the scope of the endpoint |
| 404 | `not_found` | The key or webhook does not exist for this client |
| 415 | `unsupported_media_type` | A body that is not JSON, form or multipart |
| 422 | `validation_failed` | Validation failed; `details` has field => messages (the same rules as the Developer page) |
| 422 | `webhook_inactive` | `POST webhooks/{id}/test` on a switched-off endpoint |
| 429 | `rate_limited` | Too many calls |

Example: `{ "error": "insufficient_scope", "message": "The token lacks the [developer:keys] scope.", "request_id": "01J..." }`.

## 5. Endpoints

Conventions for every call below: a single object is `{ "data": { ... } }` (unlike the public `/api/v2/webhooks` API, which returns an endpoint unwrapped); a list is `{ data, meta, links }` with `page` and `per_page` (1 to 100, default 25), `sort` (one field, `-` prefix for descending) and date ranges `created_from` / `created_to` (each bound a whole UTC day), and a bad value is a 422. A call is limited by the token's throttle of 120 calls a minute only (`X-RateLimit-Limit` and `X-RateLimit-Remaining` are on the answer, and `Retry-After` on a 429); the hourly limit of API keys does not apply here. No call takes an `Idempotency-Key`; creating calls (`POST keys`, `POST webhooks`) are not idempotent, so after a lost answer list before you retry. Every write is audited (section 6) and takes effect at once in the public API.

### `GET client` (scope `developer:profile`)

Returns the Hub client the connected user belongs to, who the user is, how the app is connected and what the create forms need. It is the first call after connecting, and the place to read the scope and event catalogues instead of hard-coding them.

```json
{ "data": {
  "id": 1001,
  "name": "Acme Agency",
  "user": { "id": 42, "name": "Dev Eloper", "email": "dev@example.com" },
  "connection": { "app": "HB Developers", "scopes": ["developer:profile", "developer:keys", "developer:webhooks"] },
  "portals": [ { "key": "hub", "label": "HB Compliance Hub", "enabled": true }, { "key": "online-training", "label": "Online Training", "enabled": true } ],
  "api_scope_groups": [ { "key": "account", "label": "Account", "scopes": [ { "scope": "account:webhooks:read", "label": "...", "access": "read" } ] } ],
  "webhook_event_groups": [ { "key": "practical-training", "label": "...", "events": [ { "event": "practical-training.booking.created", "label": "..." } ] } ]
} }
```

`id` is the Hub client id (`hb_client_id`), the same id as `client_id` in `GET /api/v2/auth/me`. `name` is the account's name, or null if the client has no HB Portal account. `user` is the person who approved the app (their name and email are returned: the token holder is that person). `connection.scopes` are the developer scopes this token carries. `api_scope_groups` lists every scope an API key may be given (plus `*` for everything and `{portal}:*` for a whole portal) and `webhook_event_groups` every webhook event, for building the create forms. Errors: the common ones of section 4.

### `GET portals` (scope `developer:profile`)

A list (`sort` = `key` or `label`, `-` prefix for descending) of `{ key, label, enabled }`: `hub` (always enabled) and the ten service portals. `enabled` is the client's portal entitlement in Hub; a portal the client does not have answers `403 portal_unavailable` on every call of the public API, whatever scopes a key holds. It is a short fixed list, so one page usually holds it all.

### `DELETE connection` (scope `developer:profile`)

Disconnects the app: revokes every access and refresh token this user gave this app, so the next call with any of them is `401 invalid_token`. Answer: `{ "data": { "disconnected": true, "revoked_tokens": 3 } }`. The keys and webhooks already created are untouched and keep working; reconnecting needs the full authorization flow again. A user can also revoke the connection from the Developer page in Hub (Connected apps).

### API keys (scope `developer:keys`)

The keys that call the public API. Key object: `id`, `name`, `prefix` (first 8 characters), `scopes`, `valid_ips`, `is_active`, `rate_limit_per_hour`, `last_used_at`, `expires_at`, `created_at`. The secret is never part of it, and is never logged.

| Call | What it does |
| --- | --- |
| `GET keys` | Lists the client's keys. Filters `is_active`, `search` (the name contains it, or the prefix starts with it, at most 100 characters), `created_from`, `created_to`; `sort` = `id` (default, newest first), `name`, `created_at`, `last_used_at`. `last_used_at` is updated when a key is exchanged for tokens |
| `POST keys` | Creates a key. Body: `name` (required, up to 100), `scopes` (required, at least one, each from `api_scope_groups` or `*`; a value that is not one is a 422 on `scopes.N`), `valid_ips` (optional list of up to 20 single IPv4 or IPv6 addresses or CIDR ranges such as `203.0.113.0/24`; empty means any address), `expires_at` (optional, a date or date-time in the future), `rate_limit_per_hour` (optional, 10 to 100000, default 1000) and `is_active` (default true). **201** with the key object plus `key` (the plain key, `hbk_` and 48 characters) and `notice`. **The plain key is in this answer only**: there is no way to read it later, only to regenerate it |
| `GET keys/{id}` | One key. A key of another client, a deleted key and an unknown id are all `404 not_found` |
| `PUT keys/{id}` | Changes the fields you send, with the same rules; fields left out keep their value. `scopes` and `valid_ips` replace the whole list (send `valid_ips: []` or `null` to allow any address, `expires_at: null` to remove the expiry). A change applies to the tokens already issued from the key at once, because the key is checked on every call. Setting `is_active: false` stops the key and its tokens |
| `POST keys/{id}/regenerate` | Replaces the key with a new one that has the same name, scopes, IP list, expiry and rate limit. **The answer is a new key object: it has a new `id`**, a new `prefix` and `created_at`, and no `last_used_at`; the plain key is in `key`, once. The old key and every token made from it stop working at once and its id answers `404` from then on. Use it when a key may have leaked |
| `DELETE keys/{id}` | Deletes the key and revokes its tokens: `{ "data": { "id": 7, "deleted": true } }`. Calls that use its tokens are `401 invalid_token` from then on. Deleting twice is `404` the second time |

`rate_limit_per_hour` can be set here (and by Healthier Business staff) but **not on the Developer page of Hub**, whose key form has no field for it: a key made on that page always has the default of 1000 calls an hour, and only this API or staff can change it.

### Webhooks (scope `developer:webhooks`)

The client's webhook endpoints, the same objects and rules as the public `/api/v2/webhooks` API (one signing secret per endpoint, events from any portal, the same https and public-server rules, 5 attempts and a switch-off after 25 failures in a row). Webhook object: `id`, `name`, `url`, `events`, `is_active`, `timeout_seconds`, `secret_prefix`, `last_delivered_at`, `last_response_code`, `consecutive_failures`, `imported`, `created_at`.

| Call | What it does |
| --- | --- |
| `GET webhooks` | Lists the endpoints. Filters `is_active`, `search` (part of the name or URL), `created_from`, `created_to`; `sort` = `id` (default, newest first), `name`, `created_at` |
| `POST webhooks` | Creates an endpoint. Body: `name` (required, up to 100), `url` (required, a full `https` URL up to 2048 characters, no username or password, resolving to a public server: private networks and plain `http` are a 422 on `url`; checked by the same URL guard as the Developer page), `events` (required, at least one, from `webhook_event_groups`), `is_active` (default true), `timeout_seconds` (5 to 30, default 10). **201** with the webhook plus `signing_secret` (`whsec_` and 48 characters) and `notice`, **once** |
| `GET webhooks/{id}` | One endpoint |
| `PUT webhooks/{id}` | Changes the fields you send; `events` replaces the whole list. Switching an endpoint on (`is_active: true`) resets its failure count, which is how to turn on an endpoint Hub switched off |
| `DELETE webhooks/{id}` | Deletes the endpoint: `{ "data": { "id": 3, "deleted": true } }`. No further event is sent to it and its pending retries fail |
| `POST webhooks/{id}/rotate-secret` | New signing secret in `signing_secret`, once. The old one stops signing at once, including for deliveries already waiting for a retry |
| `POST webhooks/{id}/test` | Queues a `webhook.test` event to the endpoint: `{ "data": { "message": "...", "delivery_id": 12 } }`. `422 webhook_inactive` when the endpoint is switched off |
| `GET webhooks/{id}/deliveries` | The endpoint's deliveries, newest first: `{ id, event_type, event_id, status, attempt, response_code, error_message, delivered_at, created_at }`. `status` is `pending`, `retrying`, `delivered` or `failed`. Filters `status`, `event_type`, `created_from`, `created_to`; `sort` = `id` (default, newest first), `created_at`, `delivered_at` |

Differences from the public API, for anyone who uses both: here a single object, the delete answer and the test answer are inside `data` (the public API returns them bare, and its delete and test answers are `{ message }`); the delivery rows here include `error_message` (the public list does not); and this API has no redeliver call. Webhook ids are the same in both.

## 6. Audit

Every write is recorded in Hub's activity log (`kind` audit, portal `hub`) with **actor = the Hub user who approved the app** (`actor_type` user, `actor_role` `oauth_app`), the client, the request id, and `properties.via = "oauth_app"` with `properties.oauth_app` (the app name) and `properties.oauth_client_id`. Actions: `developer.api-key.created|updated|regenerated|deleted`, `developer.webhook.created|updated|deleted|secret-rotated|tested`, `developer.app-disconnected`. Connecting (`oauth.app-connected`) and a revoke from the Developer page (`developer.app-revoked`) are security rows. Secrets are never logged.
