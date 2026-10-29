---
description: Build and send requests to a sandbox from the console, exchange a key for a token, save requests in collections, use variables, read responses, copy code in four languages and switch to live calls.
---
# API Playground

The **API Playground** is a request builder inside the console, a little like Postman, that knows every operation of the Hub API v2 (189 of them). You pick an operation, the form fills itself from the specification, and you press **Send**.

It sends to **one of your sandboxes** by default. It can also send **live** calls to the real Hub when the portal allows it (live calls (see Settings and live calls below)).

## The five panels of the rail

| Panel | What it holds |
| --- | --- |
| **Endpoints** | Every operation, grouped by portal, with its method and path. The search box filters by name or path; the method buttons (GET, POST, PUT, PATCH, DELETE) filter by method. |
| **History** | The requests you sent, newest first. |
| **Collections** | Requests you saved, in folders. |
| **Variables** | Values you reuse as `{{name}}`. |
| **Settings** | Live calls, history sync, API version, what this browser keeps. |

## Send your first request

1. **Pick an operation**

   Open **Endpoints**, search for *candidates* and choose **List candidates** (`GET /hub/candidates`). A request opens in a tab with the target selector, the method and path, a **Send** button and the **Params**, **Headers**, **Auth**, **Body** and **Docs** tabs.

2. **Choose the target**

   The first selector names where the request goes: one of **Your sandboxes**, or the **live Hub**. A green dot marks a live selection. The path stays the same.

3. **Authorize the request**

   Open the **Auth** tab. There are three modes:

   * **API key (automatic)**: paste a key, or let the Playground make one, and it exchanges the key for a token for you and renews it when it expires. This is the easiest.
   * **Bearer token**: paste an access token you already have.
   * **None**: send without credentials, for the operations that need none (the token exchange itself).

   **Create a test key** (the *Playground key*) makes a test key with every scope for the selected sandbox, shows it once, and replaces the previous Playground key when you make another. Keys and tokens live **in this browser tab only** and are forgotten when you close it. **Renew token now** exchanges again; **Forget key and tokens** removes them.

4. **Fill in the parameters**

   **Params** lists the query parameters of the operation (page, per_page, sort, filters) with their types; untick one to leave it out, and path parameters such as `{candidate_ref}` appear as fields. **Headers** shows the headers sent; `Accept: application/json` is there for you.

   Operations that send data have a **Body** tab with three modes: **JSON**, **Form** (multipart, with file rows) and **None**.

5. **Press Send**

   The answer opens on the right with the status, time, size and a **SANDBOX** badge, and four views: **Pretty**, **Raw**, **Headers** and **Code**. The call also appears in the [request log](hb://guides/portal-request-log-and-debugging) of the sandbox.

## Read the documentation of an operation

The **Docs** tab shows the reference page of the operation (description, parameters, scopes, responses) next to the form, so you do not have to switch pages.

## Get code for the request

The **Code** tab turns the request as it is now into code, without sending it, for the sandbox or live base address you choose. Languages: **cURL**, **JavaScript (fetch)**, **PHP (cURL)** and **Python (requests)**. Secrets in the snippet are replaced by a placeholder so it is safe to paste.

## Variables

Variables replace `{{name}}` in the path, query, headers and body, so you write a value once.

* **Name** may contain letters, digits, `_`, `.` and `-` and must start with a letter or `_`; up to 60 characters.
* **Scope**: *Global* (every request), or one sandbox (only requests to it), or live. A sandbox variable wins over a global one of the same name.
* **Secret** variables are kept **in this browser only** and are never sent to the server. A variable whose name or value looks like a key or a token (`api_key`, `Bearer ...`, `hbk_...`) is refused as a plain variable: make it secret.
* Built in: `{{uuid}}`, `{{timestamp}}` and `{{isoDate}}` generate a fresh value each time, for example for an `Idempotency-Key`.

## Collections

Save a request with **Save** (next to Send) and organise saved requests in collections.

* **New collection** creates a folder; collections can be nested, renamed, moved and deleted from their menu.
* A saved request keeps its target, method, path, parameters, headers and body, with `{{variables}}` unresolved. **Keys and tokens are never saved**: secret headers are dropped and anything shaped like a Hub key makes the save fail.
* Requests can be duplicated, renamed, moved between collections and deleted.
* **Import** reads a collection file (the format the export uses) and **Export** (collection menu) downloads one, so you can share a set of requests with a colleague.

Collections and plain variables are saved in your account, so they follow you to other devices.

## History

History is stored **on this device** by default. **Sync history to my account** (Settings) keeps it on the server so you see it on other devices; the requests stored never contain keys or tokens, and turning the switch off deletes the server copy. History entries can be opened again, and removed one by one or all at once.

## Settings and live calls

* **Live calls** shows whether the portal allows live requests (*On* or *Switched off by the portal*), whether they are **Reads and writes** or **Read only**, the live base address, and the address live calls leave from, which you may need to allow in a firewall.
* Live calls use a **live key** from HB Hub, never a test key.
* **Forget all keys and tokens**, **Close all requests** and **Clear saved data** tidy up the browser.

> **Warning: Live means live.**
>
> A live request changes real data and may cost real credits. The target selector marks live tabs with a green dot and a *Live* badge so you cannot miss it. Build and test in a sandbox first.

## Limits

The Playground is rate limited per person and per hour; when you exceed it the answer says so with the time to wait. Saved requests are limited in size and number, and a single request may hold up to 1 MB.

## Related

* [API keys and token exchange](hb://guides/portal-api-keys-and-tokens)
* [Request log and debugging](hb://guides/portal-request-log-and-debugging)
* [Reading the API reference](hb://guides/portal-reading-the-api-reference)
