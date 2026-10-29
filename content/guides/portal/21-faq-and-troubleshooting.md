---
description: Short answers to the questions developers ask most, grouped by the part of the portal, with where to look when something does not work.
---
# FAQ and troubleshooting

## Account

**I never got the confirmation email.** Check spam and quarantine, then use **Send the email again** on the Check your inbox page (three requests in ten minutes). See [Verify your email](hb://guides/portal-verify-your-email).

**Why is my Gmail address refused?** Sign-up is for work email addresses. Use your company address. See [Create your account](hb://guides/portal-create-your-account).

**Can I change my email address?** Not yourself. Contact the team behind the portal from [Support](hb://guides/portal-support-and-booking-a-call).

**I lost my phone and my recovery codes.** You cannot sign in without them. Contact support, who will verify who you are before turning two-step sign-in off.

**Can several people share one account?** Please do not. Keys, webhooks and sandboxes belong to one developer account; give each person their own.

## Sandboxes

**Does a sandbox send real emails or texts?** Never. They are kept in the [Inbox](hb://guides/portal-inbox-and-notifications).

**Does anything I do in a sandbox reach Hub?** No. The only thing that leaves a sandbox is a signed webhook to an https address you registered.

**How many sandboxes can I have?** Up to 25.

**I reset my sandbox and my webhook has gone.** Reset recreates the sandbox's data from its starting point and the webhooks live in that data. API keys are kept. Register the webhook again ([Sandboxes](hb://guides/portal-sandboxes)).

**Is the sandbox data realistic?** The format, the codes and the rules are the real ones; the people, the dates and the numbers are made up. Do not copy real personal data in.

## Keys and tokens

**I lost my key.** It cannot be shown again. **Roll** it in the console to get a new value ([API keys](hb://guides/portal-api-keys-and-tokens)).

**My calls answer `401 invalid_token`.** The access token lasts one hour. Refresh it with the refresh token, or exchange the key again.

**My calls answer `403 insufficient_scope`.** The key lacks the scope named in the message. Edit the key.

**The token exchange answers `invalid_credentials`.** The key is wrong, deleted or rolled, or it is a key of another sandbox or of the live Hub. A test key does not work against the live Hub and a live key does not work in a sandbox.

**Do I need a client id?** Not in v2. Send only `api_key`.

## Calls

**Where is the base address?** On the sandbox page, with a copy button ([Sandboxes](hb://guides/portal-sandboxes)). In production it is `https://hub.hbcompliance.co.uk/api/v2`.

**Why `429 rate_limited`?** You passed the hourly limit of the key, or more than ten token exchanges in a minute. Wait for `Retry-After` and see [Rate limits, errors and idempotency](hb://guides/portal-rate-limits-errors-and-idempotency).

**I created something twice.** Send an `Idempotency-Key` with every create. The same key and body returns the first answer instead of creating again.

**What is the `request_id` for?** It identifies one call. Quote it to support; it is in every error body and in the `X-Request-Id` header, and in the [request log](hb://guides/portal-request-log-and-debugging).

**A call is not in the request log.** It never reached the sandbox: check the base address, proxy and firewall.

## Webhooks

**My webhook never arrives.** Check in order: the address is https and public ([Webhooks](hb://guides/portal-webhooks)); the endpoint is **Active**; it listens to the event; look at the **delivery log** for the error; use **Send test event**.

**I get every event twice.** Your server answered too slowly or with a non 2xx status, so Hub retried, or you pressed **Send again**. Deduplicate on `event_id` and answer `200` immediately.

**My signature check always fails.** Compute it from the **raw** body and the `X-Hub-Timestamp` header, `HMAC-SHA256` over `timestamp.body`, with the secret of **this** endpoint. A rotated secret invalidates the old one. A framework that re-encodes the JSON changes the bytes.

**Why was my endpoint switched off?** 25 deliveries in a row failed. Fix the receiver and switch it on again in the endpoint settings.

**Can I use http or localhost?** No. Use https on a public address; a tunnelling tool works for development.

## Playground, Data, Simulate

**The Playground says I need a key.** Open the **Auth** tab and choose **Create a test key**, or paste one.

**The Data page is empty.** You are looking at a table with no rows, or at the wrong sandbox. Reset the sandbox to get the starting data back.

**A simulation will not run.** The target is not in the state the step needs. Read the message, or bring the record to the right state with an API call first ([Simulate](hb://guides/portal-simulate)).

## Support and production

**How do I book a call?** Support, **New message**, *Book a technical support call*. A 30 minute consultation is £47.50; a developer session is £95 an hour with a 30 minute minimum, paid by card with HB Pay ([Support](hb://guides/portal-support-and-booking-a-call)).

**When can I use v2 live?** Build and test in a sandbox now. Live v2 is available when the Compliance Hub is released ([Moving from the legacy APIs](hb://guides/portal-moving-from-legacy-apis-to-v2)).

**Where do production keys come from?** The Developer page of HB Hub, or from the console after you connect your HB Hub account ([Go to production](hb://guides/portal-go-to-production)).

## A checklist for any problem

1. Is it the right **base address** and the right **key** for that sandbox or for live?
2. Look at the [request log](hb://guides/portal-request-log-and-debugging): status, code, bodies.
3. Compare with the operation in the [reference](hb://guides/portal-reading-the-api-reference).
4. Reproduce it in the [Playground](hb://guides/portal-api-playground).
5. Still stuck? Send a [support message](hb://guides/portal-support-and-booking-a-call) with the `request_id`, what you expected and what you got.
