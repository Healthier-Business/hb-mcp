---
description: See the emails and texts a sandbox would have sent to candidates, search and filter them, and turn on notifications on your own device.
---
# Inbox and notifications

In the real Hub, actions send emails and texts to candidates, referees and your own staff. A sandbox never sends any of them. Instead each message is **kept in the Inbox** so you can see what would have been sent, to whom and when.

1. **Clear inbox** deletes every message of this sandbox (a confirmation is asked).
2. **Type** filter: *Email* or *SMS*.
3. A text message: the recipient is a phone number and the subject is a short label.

Columns: **Type**, **To**, **Subject** and **When**. Search matches the recipient, the subject and the text. Filter by **Type** and by **Received** (a date range). The default is newest first, 10 to a page.

## Read a message

An opened message shows the recipient, subject, text and the context that caused it.

The message shows what the candidate would have seen. A **context** block says which event or action caused it (for example `practical-training.booking.confirmed`), so you can match a message to a call or a [simulation](hb://guides/portal-simulate).

## What fills the inbox

* Calls that make Hub write to someone: booking a place, cancelling, requesting references, assigning courses.
* [Simulations](hb://guides/portal-simulate) such as *Candidate pays the booking link*.
* The same events your [webhooks](hb://guides/portal-webhooks) receive: the email is the human side of the event.

> **Tip: Test wording and links.**
>
> Use the inbox to check what your candidates will be told and which links they will get. The links point at made-up pages; nothing behind them is real.

## Notifications on this device

Separately from the inbox, the console can send **browser notifications** (for example when a support ticket gets an answer). The setting is on the **Profile** page:

A browser or portal without push support shows a note instead of a switch.

Turn it on and allow notifications when your browser asks. It applies to **this browser only**; repeat it on each device. If you block notifications in the browser settings, the switch cannot turn them on again until you allow them there.

## Related

* [Simulate](hb://guides/portal-simulate)
* [Webhooks](hb://guides/portal-webhooks)
* [Profile and security](hb://guides/portal-profile-and-security)
