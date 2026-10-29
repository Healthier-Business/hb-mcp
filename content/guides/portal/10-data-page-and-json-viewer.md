---
description: Look at every table of a sandbox, search and sort it, and open a record as an expandable JSON tree.
---
# Data page and JSON viewer

The **Data** page shows what a sandbox currently holds: one table for each collection of the API (candidates, bookings, requests, courses, credit movements and so on). It is **read only**. The data changes when you call the API, simulate events or reset; the page is how you check the result.

1. **Sandbox picker.** The data belongs to one sandbox.
2. **Table picker.** Shows the table name and its number of rows, for example *Candidates · 24*.
3. **Search rows.** Matches every text column of the table.
4. **View.** Choose which columns to show.

## Choose a table

Tables are grouped like the API: **Hub (core)**, then each portal. A name such as *Practical Training: Bookings* corresponds to `GET /api/v2/practical-training/bookings`. Sub-collections (answers of a request, the evidence of a worker) show a **parent** column with the id of the thing they belong to. The webhook tables are not listed here; use the [delivery log](hb://guides/portal-webhooks).

## Sort, search and page

* Choose a **column title** to sort by it; choose it again to reverse. The first sort is by the column that says when a row was made (marked *(created)*), newest first.
* **Search rows** filters while you type.
* 15 rows are shown per page; use the page controls under the table.
* Dates show in your time zone; hover a date to see the exact value as the API returns it (UTC with a `Z`).

## Open a record as JSON

Select any row. A dialog titled **Record** (with **Expand all**, **Collapse all** and **Copy JSON** buttons) shows the record **as the API returns it**, plus the extra fields of its single view (the same as calling `GET` on one record).

* Use the arrows to open or close a branch. Long text is shortened with an ellipsis; copy the JSON to get everything.
* Keys are shown as they appear in API answers, so you can match field names to your code without guessing.
* Select **Copy JSON** to paste the record into a test or a bug report. It never holds a key or a token, only sandbox data.

## What to use it for

* **Pick an id** to call the API with: copy a `candidate_ref` or a booking id from here instead of making one up.
* **Check the effect** of a write call or a [simulation](hb://guides/portal-simulate): did the booking become *Booked*? Did a credit movement appear?
* **See what a list returns** before you write the code that parses it.
* **Spot why a call fails**: a booking that is already cancelled, a slot that is already held.

> **Note: Reset to start over.**
>
> You cannot edit rows here on purpose: the data changes through the API, like the real thing. To get the starting data back, [reset the sandbox](hb://guides/portal-sandboxes).

## Related

* [Sandboxes](hb://guides/portal-sandboxes)
* [Simulate](hb://guides/portal-simulate)
* [API Playground](hb://guides/portal-api-playground)
