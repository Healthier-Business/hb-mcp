---
description: Sign up for the developer console with your work email address, every field of the form, the rules for passwords and email addresses, and what each error message means.
---
# Create your account

You need an account to use the console: sandboxes, keys, webhooks, the Playground and support all belong to a developer account. Reading the documentation never needs one.

> **Note: Work email addresses only.**
>
> Sign-up is for people who work for a company that uses (or wants to use) the Hub. Personal mailbox providers such as Gmail, Yahoo or Apple Mail are refused, and so are temporary or disposable addresses. Use the address you have at your employer, for example `dana@acme-staffing.example`.

## Create the account

1. **Open the sign-up page**

   Open the developer site and choose **Console** in the header, then **Create an account** under the sign-in form. You can also go straight to `/register` on the developer site. If you are already signed in you are taken to the console instead.

2. **Fill in the form**

   Fill in the form. It has these items:

   | Field | What to enter |
   | --- | --- |
   | **Name** | Your name as you want to be greeted in the console and in emails. Up to 120 characters. |
   | **Work email** | The address we confirm and use for security notices and API news. It cannot be changed later by yourself (see [Profile and security](hb://guides/portal-profile-and-security)). |
   | **Password** | At least 10 characters, with letters and numbers. A long phrase is better than a short complicated word. |
   | **Repeat the password** | The same password again. |
   | **Terms** | Tick that you agree to the terms of use and the privacy policy. You cannot create the account without it when the portal asks for acceptance. |
   | **Create account** | Sends the form. |

3. **Create the account**

   Choose **Create account**. The account is made at once and you land on the [Check your inbox](hb://guides/portal-verify-your-email) page. Until you confirm your address you cannot use the console.

## If the address is refused

The form checks the address before it creates anything. A personal mailbox shows the message below, in red under the field, and nothing is saved or sent.

## Every message you can meet

| Message | Why it appears | What to do |
| --- | --- | --- |
| Use your work email address. Personal addresses such as Gmail, Yahoo or Apple Mail are not accepted. | The domain is on the list of free mailbox providers (the portal can switch this check off). | Use your company address. |
| That looks like a temporary address. | The domain is a disposable mailbox service. | Use a permanent company address. |
| Accounts with that email domain are not accepted. | The portal owners blocked that domain. | Contact support from the developer site. |
| Sign-up is open to certain email domains only. | The portal only accepts listed company domains. | Use an address on an allowed domain, or ask for an invitation. |
| You need an invitation to create an account on this portal. | The portal is invite only. | Open the link in your invitation email, or ask the team that invited you. |
| This portal is not accepting new developers. | Sign-up is closed. | Ask support when it will reopen. |
| Sign in with your company login. Accounts are created automatically. | Your company uses single sign-on. | Use **Continue with single sign-on** on the sign-in page. |
| There is already an account with that email address. Try signing in. | The address is registered, even if it was deleted earlier. | Sign in, or use **Forgot password?** |
| The password must be at least 10 characters / needs letters and numbers. | The password is too weak. | Choose a longer password. |
| Too Many Attempts | More than 10 sign-up attempts a minute from your network. | Wait a minute and try again. |

## Sign-up modes

Which of these applies to you is a setting of the portal, not something you choose:

* **Open**: anyone with an allowed work address can sign up and starts after confirming their email. This is how the Healthier Business portal is set up.
* **Approval**: your account is created but waits for someone at the portal to approve it. Signing in shows *Your account is waiting for approval. You will get an email when it is decided.*
* **Invite only**: you need an invitation link. An invitation tied to your address also proves your mailbox, so you can skip the confirmation email.
* **Single sign-on only**: accounts are created automatically the first time you sign in with your company login.

> **Tip: Create the account for the person who will use it.**
>
> Keys, webhooks and sandboxes are owned by the developer account that created them. Create separate accounts for separate people rather than sharing one login. Sharing a password also makes the [sign-in list](hb://guides/portal-profile-and-security) useless when you need to find out who did what.

## What is created for you

When the account is created the portal also makes a personal team named after you (for example *Dana Demo's team*) and records that you accepted the current terms of use and privacy policy. Nothing is sent to Hub, and nobody can see your account in HB Hub: the developer portal and HB Hub are separate systems until you [go to production](hb://guides/portal-go-to-production).

## Related

* [Verify your email](hb://guides/portal-verify-your-email)
* [Sign in and security](hb://guides/portal-sign-in-and-security)
* [The console tour](hb://guides/portal-the-console-tour)
