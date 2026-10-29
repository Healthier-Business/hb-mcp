---
description: A step by step migration from the per-service legacy APIs to the single Hub API v2: what changes, how to try it in a sandbox now, and how to switch to live when the Compliance Hub is released.
---
# Moving from the legacy APIs to v2

The Healthier Business APIs used to be separate for each service: *Virtual BLS APIs*, *Practical Training APIs*, *Clinical Interview APIs*, *Registration Assurance Monitoring APIs*, the *HB Portal APIs V1* and others. They are marked **Deprecated** in the reference and are retiring soon (the date is to be announced). The replacement is **one** API, the **Hub API v2** (*HB Compliance Hub APIs V2* in the reference), with one sign-in, one set of scopes and one webhook endpoint for all services.

> **Note: Sandbox now, live when the Compliance Hub is released.**
>
> v2 is available **in the sandbox today**, so you can build and test the whole migration now. The live v2 API answers once the Compliance Hub is released; until then keep using your legacy integration in production. Switching to live is then a change of base address and key, described at the end of this page.

## What changes

| | Legacy APIs | Hub API v2 |
| --- | --- | --- |
| How many APIs | One per service, each with its own base path and documentation | One, `/api/v2`, with a section per portal |
| Sign-in | `POST /auth/token` with `hb_client_id` **and** `api_key` | `POST /api/v2/auth/token` with **only** `api_key`; no client id, no `Authorization` header |
| Token | One per service | **One token for every portal** the key has scopes for |
| Access control | A key per service | **Scopes** per key, written portal, resource, then read or write |
| Webhooks | Webhook endpoints per service | **One** endpoint receives the events of every portal ([Webhooks](hb://guides/portal-webhooks)) |
| Who is addressed | Internal ids in places | A `candidate_ref` uuid, never an internal id |
| Lists | Differs per service | Always `{ data, meta, links }` with `page`, `per_page`, `sort` |
| Errors | `{ "message": "Unauthenticated." }` style | `{ "error": "snake_case_code", "message", "details", "request_id" }` |
| Retries | Left to you | `Idempotency-Key` on every create, `X-RateLimit-*` and `Retry-After` |
| Test environment | Not part of the legacy documentation | A [sandbox](hb://guides/portal-sandboxes) per developer, as many as you like |

## Migrate in a sandbox

1. **Make a sandbox for the migration**

   Create a sandbox called for example *v2 migration* ([Sandboxes](hb://guides/portal-sandboxes)). It starts with data in every portal your legacy integration used.

2. **Create a key with the scopes you use today**

   Look at the legacy endpoints your code calls and give the key only the matching v2 scopes ([API keys](hb://guides/portal-api-keys-and-tokens)). For a first run, **Full access** is fine.

3. **Swap the sign-in**

   Replace the legacy token exchange (`hb_client_id` plus `api_key`) with `POST /api/v2/auth/token` and `{"api_key": "hbk_..."}`. The answer has the same shape (`token_type`, `access_token`, `refresh_token`, `expires_in` 3600, `refresh_expires_in` 604800). Keep one token for all portals instead of one per service.

4. **Map each legacy call to its v2 operation**

   Use this table as a starting point and the [reference](hb://guides/portal-reading-the-api-reference) for each field. Search the reference for the legacy page title: v2 operations have plain names.

   | Legacy area | v2 section | Typical operations |
   | --- | --- | --- |
   | Authentication | Authentication | Exchange an API key for a token pair, refresh, revoke, show the key behind the token |
   | Client, Courses, Bookings (Practical Training APIs) | Practical Training | `/practical-training/courses`, `/bookings`, `/training-events`, `/booking-invites` |
   | Timeslots, Bookings (Virtual BLS APIs) | Virtual BLS Training | `/virtual-bls-training/timeslots`, `/timeslots/hold`, `/bookings` |
   | Interview Types, Timeslots, Bookings | Clinical Interviews | `/clinical-interviews/timeslots/hold`, `/bookings` |
   | Workers, Verification, Alerts | Registration Monitoring and DBS and Right To Work | `/registration-monitoring/workers`, `/dbs-rtw/workers` |
   | Candidate, OH and training requests (HB Portal APIs V1) | Hub (core), Occupational Health, Online Training | `/hub/candidates`, `/occupational-health/requests`, `/online-training/candidates` |
   | Webhook Endpoints, Webhook Events | Account | Create a webhook endpoint, `/webhooks/events` |

5. **Replace your webhook receivers**

   Register **one** v2 endpoint for all the events you need, and verify `X-Hub-Signature` as described in [Webhooks](hb://guides/portal-webhooks). Run the old and the new receiver side by side until you trust the new one; deduplicate on `event_id`.

6. **Add idempotency and rate limit handling**

   Send an `Idempotency-Key` on every `POST` that creates something and handle `429` with `Retry-After`. See [Rate limits, errors and idempotency](hb://guides/portal-rate-limits-errors-and-idempotency).

7. **Test the whole flow with Simulate**

   Make payments, attendance and certificates happen with [Simulate](hb://guides/portal-simulate) and check the webhook deliveries, the [Data page](hb://guides/portal-data-page-and-json-viewer) and the [Inbox](hb://guides/portal-inbox-and-notifications).

8. **Run your own tests against a fresh sandbox**

   Reset the sandbox before each run so tests start from the same data. Check the [request log](hb://guides/portal-request-log-and-debugging) for any call that answered 4xx.

## Switch to live

When the Compliance Hub is released:

1. **Create a production key**

   In HB Hub (or from the console after you [connect HB Hub](hb://guides/portal-go-to-production)). Give it the same scopes you tested.

2. **Change two values**

   The base address becomes `https://hub.hbcompliance.co.uk/api/v2` and the key becomes the production key. Nothing else in your requests changes: paths, bodies and errors are the same as in the sandbox.

3. **Register the production webhook**

   Register your https endpoint in HB Hub and store its new signing secret.

4. **Cut over gradually**

   Move one account or one service at a time. Keep the legacy integration available until the new one has run cleanly for a while, then retire it. Tick **Go to production** in the console when you are done.

> **Warning: Do not mix the two.**
>
> Keep the legacy and the v2 configuration apart (separate environment variables, separate base addresses) until the cut over, and never send a v2 key to a legacy host.

## Related

* [Go to production](hb://guides/portal-go-to-production)
* [Calling the API from curl and Postman](hb://guides/portal-calling-the-api-from-curl-and-postman)
* [FAQ and troubleshooting](hb://guides/portal-faq-and-troubleshooting)
