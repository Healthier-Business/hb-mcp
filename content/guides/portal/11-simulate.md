---
description: Make the things only a person or a clock can do happen inside a sandbox, such as a candidate paying or an interview ending, and see the webhook events, emails and data changes they cause.
---
# Simulate

Some events never happen because **you** call the API. A candidate pays a booking link. An interviewer starts and ends an interview. A scheduled check finishes. The clock reaches the day a certificate expires. In the real Hub a person or a scheduled job does these; in a sandbox nobody will, so your integration would wait forever.

**Simulate** lets you make them happen on demand. Each simulation changes the sandbox exactly as the real event would, queues the **signed webhook events** it raises (to your own endpoints only), and puts the **emails and texts** in the [Inbox](hb://guides/portal-inbox-and-notifications). Nothing leaves the sandbox except those signed events.

## The Simulations tab

Each row is one simulation, with a **Run** button at the end of the row:

* **Simulation**: a title and a plain description of what happens, for example *Candidate pays the card link: a candidate pays for a candidate-pays booking. The booking is confirmed, and the documentation request and the agency notice go to the inbox.*
* **Portal**: which part of the API it belongs to. There are simulations for Clinical Appraisals, Clinical Interviews, DBS and Right To Work, Occupational Health, Online Training, Practical Training, References, Registration Monitoring and Virtual BLS Training, 58 in all.
* **Raises**: the webhook events it sends, such as `booking.confirmed`. *No event* means the real Hub sends nothing for that step, but the data still changes.

Search matches the description, portal and event names. Filter with **Portal** and **Event**: choosing `online-training.certificate.issued` shows exactly the simulations that raise it.

### Typical simulations

| Portal | Simulation | What it does | Event raised |
| --- | --- | --- | --- |
| Practical Training | Candidate pays the booking link | A pending booking becomes booked | `booking.confirmed`, maybe `training_event.seats_low` |
| Practical Training | Trainer records attendance | Marks attended or no show | `booking.attendance_marked`, `booking.no_show`, `booking.certificate_available` |
| Practical Training | Candidate books from an invitation | The invitation is used | `booking_invite.used`, `booking.created`, `booking.confirmed` |
| Clinical Interviews | The interview ends | The interview is completed | `booking.interview_completed` |
| Online Training | Candidate passes a course | Course and training complete | `course.completed`, `training.completed` |
| Online Training | Run the renewal reminders | Time moves on for expiring training | `training.expiring`, `training.expired` |
| Occupational Health | Reviewer asks for more information | The request goes back to the candidate | `request.awaiting_candidate` |
| References | Referee submits the reference | A reference arrives | `reference.submitted`, `reference.all_completed` |
| Registration Monitoring / DBS and RTW | A queued check finishes | A verification result lands | `worker.status_changed`, `dbs.status_changed`, `alert.raised` |

## Run a simulation

1. **Pick the sandbox and a simulation**

   Use the sandbox picker, then find the row. Search and filters help: type the word *certificate*, or filter by the event you want to test.

2. **Choose Run**

   A dialog opens named after the simulation, with the portal and the reminder that it **runs inside this sandbox only**. The dialog lets you choose the target, read what will happen and which events it can raise, then choose **Run**.

3. **Choose what it applies to**

   Most simulations apply to something in the sandbox: a booking, a request, a worker, a candidate. The field (*Which booking*) lists the ones the simulation can apply to, with their state, for example *#2009 · Max Palmer · Awaiting documents*, and you can search it. A simulation that applies to nothing in particular (*Run the renewal reminders*) has no target. Some have extra fields, such as a date, with their own validation messages.

4. **Choose Run**

   The simulation runs at once. A toast says `<simulation> ran in <sandbox>`, and the page shows the outcome: the events that were sent (with the status your endpoint answered, because simulations deliver straight away), the emails and texts that went to the inbox, and the changes made to the sandbox data.

If the simulation cannot apply, the dialog shows why instead of running, for example when the booking is not in the state the step needs. Pick another target or call the API to bring the data to the right state first.

## The Runs tab

Every run is kept. The **Runs** tab (the number is how many) lists them with the simulation, its target, **status**, a short message and when.

Filters: **Portal**, **Simulation**, **Status** and a **date range**. Select a run to open its full outcome again: the events, the inbox messages and the changes. Runs disappear when you [reset or delete the sandbox](hb://guides/portal-sandboxes).

## Simulations and webhooks together

1. [Add a webhook](hb://guides/portal-webhooks) to the sandbox that listens to the event you care about.
2. Run the simulation that raises it.
3. Look at the **delivery log** of the endpoint: the event arrived, signed, with the answer your server gave.
4. Look at the [Data page](hb://guides/portal-data-page-and-json-viewer) to see what changed, and the [Inbox](hb://guides/portal-inbox-and-notifications) for the messages.

Without a webhook the simulation still works; the outcome simply says the event was raised but no endpoint listens to it.

> **Tip: Test the sad paths too.**
>
> *Candidate fails a test*, *Referee declines* and *Referee email bounces* exist so you can test what your system does when things go wrong. A passing path in the sandbox does not prove the failing one works.

## Related

* [Webhooks](hb://guides/portal-webhooks)
* [Data page and JSON viewer](hb://guides/portal-data-page-and-json-viewer)
* [Inbox](hb://guides/portal-inbox-and-notifications)
