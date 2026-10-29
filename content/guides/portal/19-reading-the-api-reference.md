---
description: How the developer site is laid out, how to search it, what is on an endpoint page, how Try it works, and the tools around the reference (Ask AI, Copy for LLM, llms.txt, OpenAPI).
---
# Reading the API reference

The developer site is the public half of the portal. You do not need an account to read it.

## Find your way around

* **Header.** The brand on the left; **Search** (also opened with the keyboard shortcut shown in the box); **Ask AI**; social links; **Support** (the contact form, no account needed to read about it); **Console** (sign in or open your console); and the light and dark switch.
* **Section tabs** under the header: the same sections as the tree, one click away. *Authentication*, *Hub (core)*, *Account* (webhooks) and one section per portal come first; the legacy and deprecated APIs follow, marked **Deprecated** in their titles.
* **Left tree.** Folders open on the section you are in. A coloured badge shows the method of each operation (`GET`, `POST`, `PATCH`, `DELETE`).
* **On this page.** The outline of the page on the right follows you as you scroll.
* **Previous and next** links at the bottom follow the order of the tree.
* **Banner.** Notices from the portal, such as the move to API v2, appear above the header and can be dismissed.

## Search

Type in the search box, or open `/search?q=your words`. Results show the page title and where it sits (for example *Account*, or the legacy section it belongs to). A result for a deprecated legacy API says so in its path. The portal can use these searches to see what people look for and do not find, so a search with no result is worth a [support message](hb://guides/portal-support-and-booking-a-call).

## An endpoint page

From top to bottom:

1. **Title and breadcrumbs.** Titles are verb phrases (*List candidates*), not paths.
2. **Method, path and Try it.** `GET /api/v2/hub/candidates`. **Try it** opens a request panel on the page: fill in the parameters, choose the server, send, read the answer. It is meant for quick looks; for keys, collections and history use the [API Playground](hb://guides/portal-api-playground) in the console.
3. **Description.** What the operation does, the filters it accepts, what the `candidate_ref` is, the **scope** a key needs, and rules such as limits.
4. **Request.** Authorization, path and query parameters, body fields with their types, whether they are required, constraints (maximum lengths, enum values, defaults) and examples.
5. **Responses.** Every status the operation can answer, with the schema and an example.
6. **Code samples.** The request as cURL (with variants for Windows, HTTPie, wget and PowerShell), JavaScript, Java and more, filled with the base address of the API.
7. **Response example.** A formatted JSON answer to compare with yours.
8. **Page actions.** *Ask about this page*, *Copy for LLM* (the page as Markdown), and a `.md` version of every page (add `.md` to the address).

### Schemas

Reusable objects (a booking, an error, a webhook endpoint) are described once under **Schemas** and linked from the pages that use them. Select a type name in a response to open its schema and see every field and constraint.

### Webhook event pages

Each event has its own page: when it is sent, the envelope, the fields of `data`, and an example. They are listed under the section of their portal with the `POST` method and the event name as title.

## Tools around the reference

| Tool | Where | What for |
| --- | --- | --- |
| **Ask AI** | Header, and *Ask about this page* | Ask a question in your own words; answers cite pages of this site. |
| **Copy for LLM** and `.md` | Every page | Paste a page into your own assistant or code editor. |
| `llms.txt` | Footer and `/llms.txt` | A list of the whole site for tools that read documentation. |
| **OpenAPI** | `/sdks/openapi.json` | Import the API into a generator or a client. |
| **Postman collection** | `/sdks/postman.json` | Every operation as a ready made request. |
| **SDKs and tools** | Sidebar of the console | Client libraries when they are published. |
| **Changelog** | `/changelog` | What changed in the API and the portal, with a feed. |
| **Quickstart, glossary, samples** | Home and `/quickstart`, `/glossary`, `/samples` | Guided first steps, terms and sample code, when the portal publishes them. |

> **Tip: Link to what you mean.**
>
> Every heading and every operation has its own address. When you ask a colleague or the support team about something, send the link and the `request_id` of the failing call.

## Related

* [API Playground](hb://guides/portal-api-playground)
* [Calling the API from curl and Postman](hb://guides/portal-calling-the-api-from-curl-and-postman)
* [Moving from the legacy APIs to v2](hb://guides/portal-moving-from-legacy-apis-to-v2)
