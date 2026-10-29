---
description: Create test keys with the access you need, see a key once, roll and delete it, then exchange it for an access token and refresh it.
---
# API keys and token exchange

Every call to the API is made with a short-lived **access token**. You get one by trading an **API key**. In a sandbox you make the key yourself in the console; in production you create it in HB Hub ([Go to production](hb://guides/portal-go-to-production)).

| | Test key (sandbox) | Live key (HB Hub) |
| --- | --- | --- |
| Looks like | `hbk_test_` + 40 characters (49 in all) | `hbk_` + 48 characters (52 in all), never `hbk_test_` |
| Works against | Your sandbox only | The live Hub only |
| Made in | The console, **API keys** | The Developer page of HB Hub |
| Shown | Once, when made or rolled | Once, when made or regenerated |

## The API keys page

1. **Sandbox picker.** Keys belong to one sandbox. Pick the sandbox whose keys you want.
2. **New key** opens the creation dialog.
3. A key row. The key itself is never shown again; you see its first characters (`hbk_test_…`) so you can recognise it.
4. **Status**: *Active*, *Off* (switched off by you) or *Expired* (its expiry date passed).

Columns: **Name**, **Key** (prefix), **Access** (*All scopes* or *N scopes*), **Limit** (calls per hour), **Expires**, **Last used**, **Status**. Filters: **Status** (active, off, expired) and **Scope**; search matches the name and the prefix.

## Create a key

1. **Choose New key**

2. **Fill in the dialog**

   | Field | Rules |
   | --- | --- |
   | **Name** | 2 to 120 characters. Must be unique in the sandbox (*This sandbox already has a key with that name.*). Name it after the system that uses it. |
   | **Calls per hour** | 10 to 10,000. Default 1,000. A call over the limit is answered *429 rate_limited*. |
   | **Expires** | Optional. Never expires unless you set a date; the earliest date is tomorrow. After the end of that day the key stops working. |
   | **Access** | **Full access** (every endpoint, read and write, in every portal), **Read only** (every scope that only reads), or **Custom**. |
   | **Create key** | Makes the key. |

3. **Choose custom access when you can**

   Give an integration only what it needs. **Custom** lists the scopes of every portal as checkboxes, with a parent checkbox per portal.

   A scope reads `{portal}:{resource}:{read|write}`, for example `online-training:candidates:read`. A `write` scope also grants the matching `read`. `practical-training:*` means everything in that portal. Account (webhooks) is its own group: `account:webhooks:read` and `account:webhooks:write`.

4. **Copy the key now**

   After **Create key** the key is shown **once** in a dialog titled *Copy it now*. Copy it with the copy button, or choose **Save as .env**, then choose **I have saved it**.

   Store it in your secret store or an environment variable. The portal keeps only a scrambled copy, so a lost key cannot be shown again: roll it to get a new value.

> **Warning: Treat a test key like a real one.**
>
> It only works in the sandbox, but it will be in the same configuration files, the same CI variables and the same chat messages as your live key tomorrow. Never put a key in a web page, a mobile app or a repository.

## Edit, switch off, roll and delete

Use the row menu (the three dots at the right of the row):

* **Edit** changes the name, access, calls per hour and expiry, and has an **Active** switch. Switching a key **off** also ends every token made with it at once.
* **Roll** makes a new key value for the same key row. The old value stops working immediately and its tokens are revoked. The new value is shown once, like at creation. Use it when a key leaked, or when someone who knew it left.
* **Delete** removes the key and revokes its tokens. Calls that still use it receive *401 invalid_credentials*.

## Exchange the key for a token

1. **Send the key**

   `POST /api/v2/auth/token` with a JSON body holding only the key. There is **no** `Authorization` header and no client id.

   ```bash
   curl -X POST "https://<developer-site>/sandbox/<sandbox-id>/api/v2/auth/token" \
     -H "Content-Type: application/json" \
     -d '{"api_key": "hbk_test_YOUR_KEY"}'
   ```

2. **Read the answer**

   ```json
   {
     "token_type": "Bearer",
     "access_token": "u8jzPde0Ig...",
     "refresh_token": "xtpYlSXpfK...",
     "expires_in": 3600,
     "refresh_expires_in": 604800
   }
   ```

   The access token lasts **one hour** (3,600 seconds); the refresh token lasts **seven days** (604,800 seconds).

3. **Call the API with the access token**

   Send it on every call as `Authorization: Bearer <access_token>`. One exchange serves every portal the key has scopes for: there are no token routes under the portals.

4. **Renew before it expires**

   Exchange the refresh token with `POST /api/v2/auth/refresh` and a body of `{"refresh_token": "..."}`. You get a new pair and the old pair is revoked. A refresh token works **once**; if it is no longer good, go back to the key.

You can do the same exchange without typing anything in the [API Playground](hb://guides/portal-api-playground): its **Auth** tab has a button that makes a key for the selected sandbox and exchanges it for you.

### The four auth endpoints

| Endpoint | Purpose | Reference |
| --- | --- | --- |
| `POST /api/v2/auth/token` | Trade a key for a token pair | Exchange an API key for a token pair |
| `POST /api/v2/auth/refresh` | Trade a refresh token for a new pair | Get a new token pair with a refresh token |
| `POST /api/v2/auth/revoke` | End the access token early | Revoke the access token |
| `GET /api/v2/auth/me` | Show which key is behind the token | Show the key behind the token |

### Errors you meet here

| Answer | Code | Meaning and fix |
| --- | --- | --- |
| 401 | `invalid_credentials` | The key is unknown, deleted, rolled or malformed. Check you copied all of it, and that it belongs to this sandbox. |
| 401 | `invalid_token` | The access token expired (after an hour) or was revoked. Refresh it. |
| 403 | `insufficient_scope` | The key lacks the scope the endpoint needs; the message names it. Edit the key. |
| 403 | `key_inactive` | The key is switched off. |
| 429 | `rate_limited` | Over the key's hourly limit, or more than 10 token exchanges a minute. Wait for `Retry-After` seconds. |

> **Tip: Cache the token.**
>
> Do not exchange a key for every call. Keep the token in memory, remember when it expires (a minute early is safe), and refresh. Ten exchanges a minute is a hard limit.

## Related

* [Calling the API from curl and Postman](hb://guides/portal-calling-the-api-from-curl-and-postman)
* [Rate limits, errors and idempotency](hb://guides/portal-rate-limits-errors-and-idempotency)
* [Go to production](hb://guides/portal-go-to-production)
