# API access approval

Some areas of the Hub hold health information and criminal record information. Their API calls, and the webhook events they send, are not open to every API key. Your organisation asks for access once, in the Hub, and a member of our team reviews the request. This guide explains which areas need approval, how to ask, what your integration sees before and after the decision, and the error codes involved.

By default two areas need approval:

- **Occupational Health** (`occupational-health`), and
- **DBS & Right To Work** (`dbs-rtw`).

Hub staff choose which areas need approval, so the list can change. Do not hard-code it: read it from `GET /account/api-access` (below). The Sandbox is not part of this rule and stays open.

## How access works

Approval belongs to your organisation (your client in the Hub), not to one key. It covers one area at a time and covers both halves of the area: its API calls and its webhook events.

1. A user of your organisation who may manage developer settings opens **Developer, API access** in the Hub and sends a request. They choose one area or all of them and answer four questions: what you will build and how the integration will use the data, why you need access, who receives the data and where it is stored, and a confirmation that you have a lawful basis and a data processing agreement in place.
2. HB Compliance staff review the request and approve or reject it. You are emailed the decision. A rejection comes with a reason, which you can read in the Hub and in the email.
3. After an approval, keys that hold the scopes of the area work and webhook endpoints receive its events.
4. Staff can withdraw an approval later, with a reason. Calls are refused again and events are paused. Your keys and webhook endpoints are not deleted.

You can withdraw a request that is still waiting. After a rejection or a withdrawal you can send a new request.

## What you can do before approval

You can create an API key with the scopes of an area before it is approved, so the key is ready on the day. The Hub shows a notice when you do. The key's calls to that area are refused until approval (see the codes below). Calls to every other area work as normal.

You can also create or change a webhook endpoint, but not subscribe it to events of an area you are not approved for (see `webhook_events_not_approved`).

## Check where you stand

`GET /api/v2/account/api-access` works with any valid key, whatever its scopes. It lists every area:

```json
{
  "data": [
    { "area": "occupational-health", "label": "Occupational Health", "sensitive": true, "status": "pending", "decided_at": null },
    { "area": "online-training", "label": "Online Training", "sensitive": false, "status": "not_required", "decided_at": null }
  ]
}
```

`status` is one of:

| Status | Meaning |
| --- | --- |
| `not_required` | The area is open. Nothing to do. |
| `not_requested` | The area needs approval and nobody has asked yet. |
| `pending` | A request is waiting for review. You will be emailed when it is decided. |
| `approved` | Calls and webhook events work. |
| `rejected` | The last request was not approved. Read the reason in the Hub. |
| `revoked` | Staff withdrew an earlier approval. Read the reason in the Hub. |

`decided_at` is when the current state was decided, or `null` for `not_required`, `not_requested` and `pending`. The reason for a rejection or a withdrawal is never part of an API answer: it is shown to your users in the Hub and in the email.

Use this call to show a clear message in your own tool instead of waiting for a `403`.

## Error codes

A call to a portal that needs approval, from a key that holds a scope of that portal, is answered with `403` and one of these codes. A key with no scope for the portal gets the usual `insufficient_scope`.

| Code | When | Message |
| --- | --- | --- |
| `api_access_not_approved` | Nobody at your organisation has asked for the area | Access to Occupational Health needs approval. Request it in the Hub under API access. |
| `api_access_pending` | A request is waiting for review | Your request for access to Occupational Health is waiting for review. You will be emailed when it is decided. |
| `api_access_rejected` | The last request was not approved | Your request for access to Occupational Health was not approved. See API access in the Hub for the answer. |
| `api_access_revoked` | Staff withdrew the approval | Access to Occupational Health was withdrawn. See API access in the Hub for the reason and to request it again. |

The body is the usual error body with two extra fields:

```json
{
  "error": "api_access_not_approved",
  "message": "Access to Occupational Health needs approval. Request it in the Hub under API access.",
  "areas": ["occupational-health"],
  "docs_url": "https://dev.hbcompliance.co.uk/docs/api-access-approval",
  "request_id": "d1e5f0a2-7b3c-4c0e-9b1a-2f6a8e0c4d11"
}
```

`areas` lists the portal keys involved. These errors are not retryable: retrying will not help until the state changes. Do not loop on them.

### Webhooks

Creating or updating a webhook endpoint with events of an area you are not approved for is refused with `403` and the code `webhook_events_not_approved`. The body has `areas` (the portal keys) and `events` (the offending event names):

```json
{
  "error": "webhook_events_not_approved",
  "message": "Some of these events belong to areas that need approval: Occupational Health. Request access in the Hub under API access.",
  "areas": ["occupational-health"],
  "events": ["occupational-health.request.submitted"],
  "docs_url": "https://dev.hbcompliance.co.uk/docs/api-access-approval",
  "request_id": "d1e5f0a2-7b3c-4c0e-9b1a-2f6a8e0c4d11"
}
```

When you update an endpoint, only events it did not already hold are checked.

Events of an area that needs approval are never sent to an organisation without an active approval. Hub does not queue them and does not retry them later, so they are not replayed after an approval: fetch what you missed from the API. When staff withdraw an approval, events of that area stop from that moment, including deliveries that were waiting for a retry, which fail with a message saying so. Endpoints are kept, and events of other areas keep flowing.

## What to do in your integration

- Call `GET /account/api-access` when your integration starts, and show the status of the areas you need.
- Treat the four `api_access_*` codes as configuration problems, not as outages.
- Create webhook endpoints for sensitive areas only after the area is `approved`.
- Handle health and criminal record data as described in [health data and privacy](11-health-data-and-privacy.md).
