---
description: Ask the API team a question from the console, read their answers, choose what you need (including a paid technical support call paid with HB Pay), and what to put in a message so it is answered quickly.
---
# Support and booking a call

Support in the console is a conversation with the people who run the API. Messages are answered by **email and in the console**.

Each row has the subject, a **Status** and the time of the **Last message**. Status values are *Open*, *Waiting for the developer* (the team answered and waits for you), *Solved* and, for a call that is not yet paid, *Awaiting payment*. Search finds subjects; filter by status.

## Send a message

1. **Choose New message**

2. **Check About you**

   Your name and work email come from your account. Add your **Company**, **Role** and, only if you would like a call, a **Phone** number.

3. **Say what you need**

   Pick the closest of: *Help building an integration*, *Something is not working*, *Access, keys or credentials*, *Webhooks*, *Sandbox or test data*, *Going live*, *Billing or plans*, *The documentation*, *Book a technical support call*, *Request a custom integration or modification*, *Something else*. Then choose **Which part of the API** (or *Not sure*) and **Which environment** (for example *Sandbox*).

4. **Describe it**

   The form asks, in order:

   * **How much is it affecting you?** *Just a question*, *Blocking my development*, *Live issue affecting some of my users*, *Live issue affecting all of my users*. The last three raise the priority of the ticket to **high**, as does *Something is not working*.
   * **A short title** (for example *Hold a timeslot returns 422 for valid slots*).
   * **What are you trying to do?**
   * **How do you call the API?** An SDK, cURL, Postman or similar, your own code, Zapier or another no-code tool, or something else, with the language or SDK version.
   * **What have you tried?** A level of effort and a tick list: read the documentation, searched the docs and the FAQ, checked the status page, reproduced it in the sandbox, looked at your request logs in the console, repeated the request with cURL or Postman, checked your key and its scopes, checked your webhook deliveries, checked firewall or proxy, tried again later, asked a colleague.
   * **What did you find?** and **Evidence**: paste a request and response or a log. Never paste a key, a token or a signing secret.

5. **Choose Send request**

   You land on the conversation. The team replies by email and in the console.

> **Tip: What gets answered fastest.**
>
> The `request_id` of a failing call (from the [request log](hb://guides/portal-request-log-and-debugging) or the `X-Request-Id` header), what you expected, what you got, and what you already tried.

## Read and answer a conversation

Reply at the bottom of the page. You can change the status of a conversation yourself (for example mark it **solved**). Messages from the team are marked as coming from staff.

## Book a technical support call

Choose **Book a technical support call** under *What do you need?*. The form then asks for the kind of call and shows the price before you send anything:

| Kind | Length | Price |
| --- | --- | --- |
| Quick consultation | 30 minutes | £47.50 |
| Developer support session | 30 to 240 minutes in 30 minute steps | £95 per hour pro rata, 30 minute minimum |

Prices are in pounds sterling and shown as entered, without a VAT line. A call is paid with a card through **HB Pay**:

1. Send the request. A conversation is made with the status *Awaiting payment*.
2. You are taken to the hosted HB Pay checkout. Pay by card.
3. You come back to the conversation; once the payment is confirmed the status becomes *Open* and the team agrees a time with you in the conversation.
4. If you left the checkout without paying, open the conversation and choose **Pay** to start a new checkout. Nothing is charged until you complete it.

If card payments are not available the page tells you so and the conversation stays open without a payment.

> **Warning: Never type card details into the console.**
>
> Card details are only entered on the hosted HB Pay checkout page. The console never asks for them.

## Request a custom integration

*Request a custom integration or modification* opens the same form for something that is not in the API yet. Describe the business need, the volume and the deadline. It is a request for a conversation, not a commitment.

## Related

* [FAQ and troubleshooting](hb://guides/portal-faq-and-troubleshooting)
* [Request log and debugging](hb://guides/portal-request-log-and-debugging)
* [Go to production](hb://guides/portal-go-to-production)
