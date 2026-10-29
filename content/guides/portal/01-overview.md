---
description: What the Healthier Business developer portal is, what is in it and the shortest path from a new account to a working integration.
---
# Overview

The developer portal is where you build and test an integration with the Healthier Business Compliance Hub **before** anything touches real candidates. It has two halves that work together:

* The **developer site** (the public documentation site): the guides, the API reference, search, the changelog and the support form. Anyone can read it.
* The **console** (you need an account): your own sandboxes, API keys, webhooks, the API Playground, a request log and an inbox. This is where you try things.

These guides walk through every screen of the console: what each screen is for, every option and field, and the errors you can meet.

The documentation itself is organised in sections, one for each portal of the Hub, plus the legacy APIs that are being retired.

## The shortest path

1. **Create an account**

   Sign up with your **work** email address and confirm it. See [Create your account](hb://guides/portal-create-your-account) and [Verify your email](hb://guides/portal-verify-your-email).

2. **Create a sandbox**

   A sandbox is your own private copy of the Hub API filled with made-up candidates, bookings, requests and credits. See [Sandboxes](hb://guides/portal-sandboxes).

3. **Create a test key and exchange it for a token**

   Test keys start with `hbk_test_`; live keys start with `hbk_` without `test_`. You trade one for a one hour access token with `POST /api/v2/auth/token`. See [API keys and token exchange](hb://guides/portal-api-keys-and-tokens).

4. **Make your first call**

   Use the [API Playground](hb://guides/portal-api-playground) in the console, or curl and Postman ([Calling the API](hb://guides/portal-calling-the-api-from-curl-and-postman)). The call appears in the [request log](hb://guides/portal-request-log-and-debugging).

5. **Add a webhook**

   Hub tells you when something happens (a booking is confirmed, a certificate is issued). See [Webhooks](hb://guides/portal-webhooks), and use [Simulate](hb://guides/portal-simulate) to make the events happen on demand.

6. **Go to production**

   Create a production key in HB Hub, change the base URL and register your production webhook. See [Go to production](hb://guides/portal-go-to-production).

## What each part of the console is for

| Console page | What you do there | Guide |
| --- | --- | --- |
| Home | See your getting started checklist and account status | [The console tour](hb://guides/portal-the-console-tour) |
| Sandboxes | Create, rename, reset and delete test copies of the API | [Sandboxes](hb://guides/portal-sandboxes) |
| API keys | Create test keys with exactly the access you need | [API keys and token exchange](hb://guides/portal-api-keys-and-tokens) |
| Webhooks | Receive signed events at your own https address | [Webhooks](hb://guides/portal-webhooks) |
| Data | Look inside a sandbox, table by table, as JSON | [Data page and JSON viewer](hb://guides/portal-data-page-and-json-viewer) |
| Simulate | Make things that need a person or a clock happen | [Simulate](hb://guides/portal-simulate) |
| API Playground | Build and send requests, save them, get code | [API Playground](hb://guides/portal-api-playground) |
| Request log | Every call to the sandbox with what came back | [Request log](hb://guides/portal-request-log-and-debugging) |
| Inbox | The emails and texts the sandbox would have sent | [Inbox](hb://guides/portal-inbox-and-notifications) |
| Go to production | The checklist and the HB Hub connection | [Go to production](hb://guides/portal-go-to-production) |
| Support | Ask the team, book a paid call | [Support](hb://guides/portal-support-and-booking-a-call) |
| Profile and Security | Your details, password, two-step sign-in, sessions | [Profile and security](hb://guides/portal-profile-and-security) |

> **Note: Nothing in a sandbox is real.**
>
> A sandbox never contacts Hub, never sends an email or a text, and never costs anything. The only thing it ever sends out is a signed webhook to an https address **you** registered. Test keys do not work against the live Hub, and live keys do not work in a sandbox.

## How this guide is organised

Each guide starts with what the screen is for, then numbered steps, then every option and field, the errors you can meet and how to fix them. If you are in a hurry, read [Rate limits, errors and idempotency](hb://guides/portal-rate-limits-errors-and-idempotency) and the [FAQ and troubleshooting](hb://guides/portal-faq-and-troubleshooting) pages; they collect what people get stuck on.

> **Tip:** Not sure where something is? Use the search box at the top of the developer site, or open the [API reference tour](hb://guides/portal-reading-the-api-reference) to learn how the reference pages are laid out.
