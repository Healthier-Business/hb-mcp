---
description: Read every call your sandbox answered, filter by method and result, open a call to see both bodies, and work out why a call failed using the error code and request id.
---
# Request log and debugging

The **Request log** records every call made to a sandbox: who made it (which key), what was asked, what came back and how long it took. It is the first place to look when something in your integration does not behave.

1. **Method** filter: GET, POST, PUT, PATCH, DELETE.
2. **Result** filter: successful (200 to 399), client error (400 to 499) or server error (500 and above).
3. **Search** matches the path, the request id and the operation name.
4. A rate limited call: `429 rate_limited`, answered in 6 ms because nothing was done.
5. A validation failure: `422 validation_failed`.

Columns: **Call** (method and path with the query string), **Answer** (status and the error code when there is one), **Time** (milliseconds the sandbox took), **Key** (the first characters of the key used, so you can tell which integration made it) and **When**. Sort by **Answer** or **Time** to find the slowest or the failing calls. The default is newest first, 25 to a page.

> **Note: Tokens and keys are never kept.**
>
> The log stores the key prefix, never the key or the access token, and request and response bodies are stored without credentials.

## Open a call

Select a row to see the whole exchange.

You get the **request id**, the operation name (for example `hub.candidates.create`), the address the call came from, the **request body** and the **response body**. For an error the body is the standard shape:

```json
{
  "error": "validation_failed",
  "message": "The email field must be a valid email address.",
  "details": { "email": ["The email field must be a valid email address."] },
  "request_id": "01JD8Q4Z8E5YF6Z2W0KQ7M9N3A"
}
```

The same `request_id` is in the `X-Request-Id` header of every answer. **Quote it** when you contact support; it finds your call straight away.

## Filter

Combine the filters. *Result: client error* and *Method: POST* shows every create call that your code got wrong.

## A debugging routine

1. **Find the call**

   Filter by result, or search for the path. If nothing is there, the call never reached the sandbox: check the base address (`/sandbox/<id>/api/v2/...`), the host name, your proxy and your firewall.

2. **Read the status and code**

   | Status and code | Usually means |
   | --- | --- |
   | 400 `bad_request` | The JSON body could not be parsed. |
   | 401 `invalid_token` | The access token expired or was revoked: refresh it. |
   | 401 `invalid_credentials` | The key is wrong, deleted or rolled. |
   | 403 `insufficient_scope` | The key lacks the scope named in the message. |
   | 404 `not_found` | Wrong id, or the record belongs to another client. |
   | 409 `conflict` / `slot_taken` / `idempotency_conflict` | The state does not allow it, the slot is taken, or the idempotency key was reused with a different body. |
   | 422 `validation_failed` | A field is wrong: read `details`. |
   | 429 `rate_limited` | Over the key's hourly limit: wait `Retry-After` seconds. |
   | 500 `server_error` | Something failed in the sandbox: quote the `request_id`. |

3. **Compare with the reference**

   Open the operation in the [reference](hb://guides/portal-reading-the-api-reference) or the Playground **Docs** tab and compare required fields and formats.

4. **Reproduce it in the Playground**

   Send the same request from the [Playground](hb://guides/portal-api-playground). If it works there, the difference is in what your code sends (headers, encoding, base address).

5. **Look at the data**

   Check the [Data page](hb://guides/portal-data-page-and-json-viewer) for the record, and the [webhook delivery log](hb://guides/portal-webhooks) if the problem is an event.

## Related

* [Rate limits, errors and idempotency](hb://guides/portal-rate-limits-errors-and-idempotency)
* [FAQ and troubleshooting](hb://guides/portal-faq-and-troubleshooting)
