---
description: Make your first calls to a sandbox with curl, import the OpenAPI document or Postman collection, and use variables so the same requests work against production later.
---
# Calling the API from curl and Postman

You can drive a sandbox from any HTTP client. The console gives you the base address and the key; the [SDKs and tools](hb://guides/portal-reading-the-api-reference) page gives you machine readable descriptions of the API.

## What you need

* A sandbox and its **base address**, for example `https://<developer-site>/sandbox/<sandbox-id>/api/v2` ([Sandboxes](hb://guides/portal-sandboxes)).
* A **test key** of that sandbox ([API keys](hb://guides/portal-api-keys-and-tokens)).

## First calls with curl

1. **Set two variables**

   ```bash
   BASE="https://<developer-site>/sandbox/<sandbox-id>/api/v2"
   KEY="hbk_test_YOUR_KEY"
   ```

2. **Exchange the key for a token**

   ```bash
   TOKEN=$(curl -s -X POST "$BASE/auth/token" \
     -H "Content-Type: application/json" \
     -d "{\"api_key\": \"$KEY\"}" | jq -r .access_token)
   ```

3. **List candidates**

   ```bash
   curl -s "$BASE/hub/candidates?per_page=5" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/json"
   ```

   A list answers `{ "data": [...], "meta": {...}, "links": {...} }` and takes `page`, `per_page` and `sort`. A person is addressed by `candidate_ref`, a uuid, never by an internal id.

4. **Create something with an idempotency key**

   ```bash
   curl -s -X POST "$BASE/hub/candidates" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: $(uuidgen)" \
     -d '{"first_name":"Priya","last_name":"Nair","email":"priya.nair@example.org"}'
   ```

   Repeat the same command with the same `Idempotency-Key` and the answer is the first answer again, with `Idempotent-Replayed: true`. See [Rate limits, errors and idempotency](hb://guides/portal-rate-limits-errors-and-idempotency).

5. **Look at the call in the console**

   Open the [Request log](hb://guides/portal-request-log-and-debugging): both calls are there with their status, time and bodies.

Every answer carries `X-Request-Id`. Quote it when you contact support.

## Use Postman

The developer site serves the API description as files, so you can import it into Postman or any generator. The **SDKs and tools** page lists client libraries once they are published (at the moment it says *No client libraries yet*), and these two addresses work on the same host:

1. **Download the Postman collection**

   Open `/sdks/postman.json` on the developer site and save it. The OpenAPI document is at `/sdks/openapi.json` (and `/sdks/openapi.yaml`), for generators and other tools.

2. **Import it in Postman**

   **Import**, then choose the file. Every operation appears, grouped by portal.

3. **Create an environment**

   Add `baseUrl` (your sandbox address) and `apiKey` as variables. Mark `apiKey` as a **secret** variable.

4. **Exchange and store the token**

   Send the auth request first. In its **Tests** tab save the token for later requests:

   ```javascript
   pm.environment.set("accessToken", pm.response.json().access_token);
   ```

   Set the collection's authorization to **Bearer Token** with `{{accessToken}}`.

> **Tip: Use the console to explore, Postman to automate.**
>
> The [API Playground](hb://guides/portal-api-playground) needs no setup and knows every operation; use it when you are learning. Use Postman or code when you want repeatable runs.

## Pointing the same requests at production

Keep the base address and key in variables. When you [go to production](hb://guides/portal-go-to-production) you change two values (`BASE` becomes `https://hub.hbcompliance.co.uk/api/v2`, `KEY` becomes the live key) and nothing else.

## Related

* [API keys and token exchange](hb://guides/portal-api-keys-and-tokens)
* [API Playground](hb://guides/portal-api-playground)
* List candidates, Create a candidate
