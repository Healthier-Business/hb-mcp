---
description: Create, rename, reset and delete sandboxes, read their addresses and numbers, and understand what a sandbox contains and what it never does.
---
# Sandboxes

A **sandbox** is your own copy of the Hub API v2 with made-up data. It answers the same paths, in the same format, with the same errors as the live API, but it lives entirely inside the developer portal:

* It **never contacts Hub**, so nothing you do can change a real candidate, booking or balance.
* It **never sends an email or an SMS**; the messages are kept in the [Inbox](hb://guides/portal-inbox-and-notifications).
* It **never costs anything**: credits and payments are pretend.
* The **only** thing that leaves a sandbox is a signed [webhook](hb://guides/portal-webhooks) to an https address that you registered.
* Its data **changes when you call the API**, exactly like the real thing, until you reset it.

You can have up to **25 sandboxes** (the counter on the page reads, for example, *You have 3 of 25*). Use several: one for development, one for your continuous integration tests, one for a risky experiment.

## The Sandboxes page

1. **New sandbox** creates one.
2. **Search** by name.
3. A sandbox row: the name, and under it the **base address** you call. Select the row to open the sandbox.
4. **Status**: *Ready* when it can be used. A sandbox that is still being built shows *Creating*.

The columns are **Name**, **Status**, **Requests** (calls answered so far), **Size** (of its data), and **Last used**. Choose a column title to sort, **Status** to filter, and **View** to choose which columns show.

## Create a sandbox

1. **Choose New sandbox**

   The dialog asks for a name only.

2. **Type a name**

   Between 2 and 120 characters, unique among your sandboxes. A duplicate shows *You already have a sandbox with that name.*

3. **Choose Create sandbox**

   You land on the sandbox page and a toast confirms *Sandbox created.* It starts with made-up candidates, bookings, requests and credits **in every portal** (Occupational Health, Online Training, Practical Training, Virtual BLS Training, Clinical Interviews, Clinical Appraisals, References, Registration Monitoring and DBS and Right To Work).

If you already own 25 sandboxes the dialog says *You can have up to 25 sandboxes. Delete one you no longer use first.*

## The sandbox page

* **Address.** The base URL of this sandbox, with a copy button. Use it in place of the live host; the paths after it are the same as the Hub API, for example `/api/v2/hub/candidates`. You sign in with a key of this sandbox ([API keys and token exchange](hb://guides/portal-api-keys-and-tokens)).
* **Numbers.** *Requests* answered, *Size* of the data, *Last used*, and *Resets* (how many times you started over).
* **Rename.** Change the name and choose **Save name**. The address does not change, so nothing you configured breaks.
* **Start over or remove.** The two buttons below.

### Two ways to address a sandbox

| Form | Example | When to use |
| --- | --- | --- |
| By sandbox id | `https://<developer-site>/sandbox/<sandbox-id>/api/v2/hub/candidates` | The address shown on the page; the sandbox is named in the path. |
| By key | `https://<developer-site>/sandbox/api/v2/hub/candidates` | The key you exchange identifies the sandbox, so you can keep the same code and swap only the key. |

Both reach the same data. Calls in the [Playground](hb://guides/portal-api-playground) use the first form.

## Reset a sandbox

**Reset data** throws away everything in the sandbox's data and makes it again from the same starting data (each sandbox has its own fixed seed, so you get back exactly what you started with). Your **API keys are kept**. Everything that lives inside the data is gone: **webhook endpoints and their delivery logs, the inbox and the simulation runs**. Use it before a test run, or after you deleted or broke things.

> **Warning: Reset is immediate and removes your webhooks.**
>
> There is no undo. The *Resets* counter on the page goes up by one. The request log keeps its entries, so you can still see what led up to it. The confirmation text says that webhooks are kept; in fact they are removed together with the data, so register them again afterwards (or recreate them in your test setup).

## Delete a sandbox

**Delete sandbox** removes the sandbox for good: its data, its request log and its API keys, and with the data its webhooks and inbox.

The confirmation reads *The sandbox, its data and its request log are removed for good. Its API keys stop working.* Anything still calling the old address stops working. Webhook endpoints registered in the sandbox disappear with it, so you no longer receive events from it.

## Good habits

* **One sandbox per purpose.** Tests that reset their sandbox must not share it with a colleague who is half-way through a manual experiment.
* **Name them clearly.** *Acme staging*, *Acme CI*, *Payroll experiment* tell you what they are for months later.
* **Reset in your test setup**, not by hand, when you need a known starting point: a sandbox always returns to its own starting data, so tests are repeatable. Remember to create the webhook endpoint again after a reset.
* **Remember that the data is fake but the format is real.** Never copy real candidate data into a sandbox.

## Related

* [API keys and token exchange](hb://guides/portal-api-keys-and-tokens)
* [Data page and JSON viewer](hb://guides/portal-data-page-and-json-viewer)
* [Rate limits, errors and idempotency](hb://guides/portal-rate-limits-errors-and-idempotency)
