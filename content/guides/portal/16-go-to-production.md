---
description: The checklist for moving an integration from a sandbox to the live HB Hub, doing it by hand or connecting your HB Hub account to manage production keys and webhooks from the console.
---
# Go to production

When your integration works in a sandbox, point it at the live Hub with a real key. The **Go to production** page of the console has two ways to do it, the manual way and the connected way (you connect your HB Hub account), and a checklist that applies to both.

> **Note: The two systems are separate.**
>
> The developer portal cannot see inside HB Hub. Production keys and webhooks live in HB Hub (on its **Developer** page, where you need the Developer role). The console either sends you there, or, once you connect your HB Hub account, does it for you.

## The checklist

Whatever way you choose, go through it before the first live call:

1. **Create a new production key in HB Hub**

   Do **not** reuse a test key; it will not work live anyway. Give the production key only the scopes the integration needs.

2. **Add an IP allowlist to the key**

   If your calls come from fixed addresses, restrict the key to them. A call from another address is refused with `403 ip_not_allowed`.

3. **Keep the key in a secret store**

   An environment variable or a secret manager, never in code, in a web page, in a mobile app or in chat.

4. **Change the base URL**

   From your sandbox address to `https://hub.hbcompliance.co.uk` (so `https://hub.hbcompliance.co.uk/api/v2/auth/token`), and use the production key. Nothing else in your requests changes.

5. **Register your production webhook endpoint**

   Register it in HB Hub, and store its **new** signing secret: it is different from your sandbox secret. Verify the signature on every call ([how](hb://guides/portal-webhooks)). Hub requires an https address.

6. **Send an Idempotency-Key and handle 429 and 5xx**

   Send an `Idempotency-Key` on every call that creates something, and pause and retry on 429 and 5xx with a back-off that respects `Retry-After`. See [Rate limits, errors and idempotency](hb://guides/portal-rate-limits-errors-and-idempotency).

## Do it manually

1. **Open the Developer page of HB Hub**

   Choose **Open the Developer page**. You sign in to HB Hub with your own account; you need the Developer role there.

2. **Create the production key and the webhook**

   Follow the checklist above in HB Hub.

3. **Come back and confirm**

   Choose **I have set up production in HB Hub**. We cannot see inside HB Hub, so this is your word: it ticks *Go to production* on the [getting started checklist](hb://guides/portal-the-console-tour). You can undo it later.

## Connect your HB Hub account

Connecting lets you create and change production keys and webhooks from the console, without opening HB Hub.

1. **Choose Connect HB Hub**

   You are sent to HB Hub, where you sign in as normal and approve this console. The scopes asked for are `developer:profile`, `developer:keys` and `developer:webhooks`. You need the Developer role in HB Hub.

2. **Approve and return**

   If you cancel in HB Hub the console says *You cancelled the connection in HB Hub.* On success it says *HB Hub is connected.* and shows the HB Hub client and user you connected.

3. **Manage production from the console**

   You can now create, regenerate and delete **production keys** (a new key is shown once, like a test key) and register, test and delete **production webhooks** (the signing secret is shown once). Each action is carried out in HB Hub with your permissions.

4. **Disconnect when you are done**

   **Disconnect** removes the link. *The keys and webhooks you made there keep working.* The connection can be made again at any time.

If the connection is not available you see *Connecting to HB Hub is not set up for this portal yet.* Use the manual way.

## Moving from the sandbox: what changes

| | Sandbox | Production |
| --- | --- | --- |
| Base URL | `https://<developer-site>/sandbox/<id>/api/v2` | `https://hub.hbcompliance.co.uk/api/v2` |
| Key | Test key from the console | Production key from HB Hub |
| Data | Made up, resettable | Real candidates, bookings and credits |
| Emails and texts | Kept in the Inbox | Really sent |
| Webhooks | Sandbox endpoint, test secret | Production endpoint in HB Hub, its own secret |
| Payments and credits | Pretend | Real |

> **Warning: Test with one real record first.**
>
> Before switching a whole system over, run one real, low-risk record end to end and check it in HB Hub. The sandbox mimics the API, not every business rule of your real account (your credit balance, your courses, your locations).

## Related

* [Moving from the legacy APIs to v2](hb://guides/portal-moving-from-legacy-apis-to-v2)
* [Webhooks](hb://guides/portal-webhooks)
* [Support](hb://guides/portal-support-and-booking-a-call)
