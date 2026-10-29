---
description: Your name, time zone and password, the account security page, downloading your data and deleting your account.
---
# Profile and security

Two pages under **Account** in the sidebar: **Profile** for who you are, **Security** for how you sign in.

## Profile

| Field | Notes |
| --- | --- |
| **Name** | How you are greeted and how you appear in conversations with the team. |
| **Email** | Shown, not editable. *To change the address, contact the team behind this portal.* The address is the one you confirmed at sign-up. |
| **Time zone** | An IANA name such as `Europe/London`. Times in the console follow it. |
| **Save** | Stores name and time zone. |

### Change your password

Enter the **Current password**, the **New password** (at least 10 characters with letters and numbers) and **Repeat the password**, then **Update password**. A wrong current password is refused. Use a password you use nowhere else, ideally from a password manager.

### Notifications on this device

See [Inbox and notifications](hb://guides/portal-inbox-and-notifications).

## Security

* **Two-step sign-in**: set up and turn on with an authenticator app. Details in [Sign in and security](hb://guides/portal-sign-in-and-security).
* **Your data**: **Download** gives you a file, `my-data.json`, with your account details (id, email, name, time zone, language, when you joined and last signed in), the teams you belong to with your role, and your Playground collections, saved requests, variables and history.
* **Delete your account**: enter your **Password** and choose **Delete account**. All your sessions end at once and you can no longer sign in. You cannot undo it yourself, and the address cannot be used to sign up again afterwards (the sign-up form says there is already an account). Keys you made in HB Hub are **not** affected.
* **Where you are signed in**: every browser with a session, with **Sign out** for each and **Sign out everywhere else**.

> **Warning: Before you delete.**
>
> Download your data first, export any Playground collections you want to keep, and write down the webhook endpoints and settings you will need to recreate. Production keys and webhooks live in HB Hub and keep working, but you will no longer be able to manage them from this console.

## Related

* [Sign in and security](hb://guides/portal-sign-in-and-security)
* [Create your account](hb://guides/portal-create-your-account)
