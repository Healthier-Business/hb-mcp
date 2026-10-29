---
description: A walk through the console: the sidebar, the getting started checklist, the account menu, the theme switch, and how it looks on a phone.
---
# The console tour

The console is the signed-in part of the developer site. Everything in it is scoped to **you**: other developers cannot see your sandboxes, keys, webhooks or saved Playground requests, and you cannot see theirs.

## The home page

1. **Sidebar.** Every part of the console, explained below.
2. **Getting started.** A checklist that ticks itself off as you work. The bar shows how far along you are (for example *5 of 6*), and **Go to production** at the right opens the [production page](hb://guides/portal-go-to-production).
3. **Your account.** Whether your email is confirmed, whether two-step sign-in is on (with a **Turn on** button when it is not), and when you became a member.
4. **Account menu.** Your initial in the top right corner.

### The getting started checklist

| Item | It is ticked when | Where to do it |
| --- | --- | --- |
| Confirm your email | You used the link in the confirmation email | [Verify your email](hb://guides/portal-verify-your-email) |
| Create a sandbox | You own at least one sandbox | [Sandboxes](hb://guides/portal-sandboxes) |
| Create a test key | A key exists in one of your sandboxes | [API keys](hb://guides/portal-api-keys-and-tokens) |
| Make a call in the sandbox | Your sandbox has answered a call | [Playground](hb://guides/portal-api-playground) or [curl](hb://guides/portal-calling-the-api-from-curl-and-postman) |
| Set up a webhook | A sandbox has a webhook endpoint | [Webhooks](hb://guides/portal-webhooks) |
| Go to production | You marked production as set up, or connected HB Hub | [Go to production](hb://guides/portal-go-to-production) |

Each card is also a link to the page where you do the step. Ticked cards are crossed through.

## The sidebar

| Link | What it opens |
| --- | --- |
| Home | The page above |
| Sandboxes | Your sandboxes: [create, rename, reset, delete](hb://guides/portal-sandboxes) |
| API keys | [Test keys](hb://guides/portal-api-keys-and-tokens) of a sandbox |
| Webhooks | [Endpoints and their delivery logs](hb://guides/portal-webhooks) |
| Data | The [rows inside a sandbox](hb://guides/portal-data-page-and-json-viewer) |
| Simulate | [Make events happen](hb://guides/portal-simulate) |
| API Playground | [Build and send requests](hb://guides/portal-api-playground) |
| Request log | [Every call to the sandbox](hb://guides/portal-request-log-and-debugging) |
| Inbox | [Emails and texts](hb://guides/portal-inbox-and-notifications) the sandbox would have sent |
| Go to production | [The checklist and the HB Hub link](hb://guides/portal-go-to-production) |
| Documentation | Back to the developer site |
| SDKs and tools | The OpenAPI file and Postman collection |
| Support | [Ask the team](hb://guides/portal-support-and-booking-a-call) |
| Account: Profile, Security | [Your details and sign-in settings](hb://guides/portal-profile-and-security) |

> **Tip: One sandbox picker, five pages.**
>
> API keys, Webhooks, Data, Simulate, Request log and Inbox all work on **one sandbox at a time**. Each of them has a sandbox selector at the top; the choice is carried in the address (`?sandbox=...`), so a link you copy opens the same sandbox.

## The account menu

The sun icon next to it switches between light and dark mode. The choice is remembered in your browser. **Documentation** at the top takes you back to the developer site; the console and the documentation share the same header style so you do not feel you changed websites.

## On a phone

The console works on narrow screens. The sidebar hides behind the menu button in the top left corner.

Tables turn into scrollable lists. For long editing sessions (the Playground in particular) a computer is more comfortable.

## Breadcrumbs

Above every page title a trail such as **Healthier Business > Console > Sandboxes** shows where you are. Each earlier item is a link.

## Related

* [Sandboxes](hb://guides/portal-sandboxes)
* [Profile and security](hb://guides/portal-profile-and-security)
