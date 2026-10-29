---
description: Signing in, resetting a forgotten password, turning on two-step sign-in with an authenticator app, recovery codes, and how sessions and lockouts behave.
---
# Sign in and security

Your developer account holds keys that can act on your sandboxes and, through the Go to production page, on HB Hub. Protect it like any other credential.

## Sign in

1. **Open the sign-in page**

   Choose **Console** in the header of the developer site, or go to `/login`.

2. **Enter your details**

   Enter your **Email** and **Password**. Tick **Keep me signed in** on a device only you use: the session then lasts up to 30 days instead of ending after 8 hours without activity.

3. **Choose Sign in**

   Choose **Sign in**. If two-step sign-in is on, you are asked for a code next (see below). **Create an account** opens the [sign-up form](hb://guides/portal-create-your-account).

If your company uses single sign-on, enter your work address and choose **Continue with single sign-on**; your company login page opens and you come back signed in.

### Messages on the sign-in form

| Message | Meaning |
| --- | --- |
| These details do not match an account. | Wrong email or password. The message is the same for both on purpose. |
| Too many attempts. Try again in N minutes. | Repeated failures locked sign-in for that account and network for a while. |
| Your account is waiting for approval. | The portal approves new developers by hand. |
| This account is suspended. | The portal owners switched it off. Contact support. |
| (the Check your inbox page) | The address is not confirmed yet. See [Verify your email](hb://guides/portal-verify-your-email). |

## Forgot your password

1. **Choose Forgot password?**

   The link is next to the password field. It opens the reset page.

2. **Enter your email and send the link**

   Choose **Send the link**. For privacy the page says the same thing whether or not the address has an account. At most five requests a minute are accepted.

3. **Open the link and choose a new password**

   The link works for **60 minutes** and can be used once. Choose a password of at least 10 characters with letters and numbers.

## Turn on two-step sign-in

Two-step sign-in asks for a 6-digit code from an authenticator app (1Password, Authy, Google Authenticator or any TOTP app) after your password. A stolen password is then not enough.

1. **Open Security**

   Choose **Security** in the sidebar. On the console home page the **Turn on** button of the account card leads to the same place.

2. **Choose Set up two-step sign-in**

   A QR code and a text key appear.

3. **Scan the code, enter the six digits and choose Turn on**

   Until you confirm with a valid code nothing changes: setup that you abandon leaves two-step sign-in off.

4. **Save your recovery codes**

   After **Turn on** the portal shows single-use **recovery codes**, once. Store them in a password manager. Each one signs you in once if you lose your phone.

> **Warning: Recovery codes are shown once.**
>
> The portal keeps the secret and the recovery codes encrypted and cannot show the codes again. If you lose both your phone and the codes, you cannot sign in; ask support to turn two-step sign-in off after they have verified who you are.

### Signing in with two-step on

After the password you see the code page. Enter the 6-digit code from the app, or a recovery code. Codes are accepted for a short window either side of the current time, so make sure your phone's clock is set automatically. At most 20 attempts a minute are accepted.

## Where you are signed in

The **Security** page lists every browser signed in to your account, with the device, the network address, how you signed in and when.

Choose **Sign out** on a row to end that session, or **Sign out everywhere else** to end all but the current one. Do this after using a shared computer and whenever a row looks unfamiliar; then change your password.

## Lockouts and rate limits

| Where | Limit |
| --- | --- |
| Sign in | 20 attempts a minute per network, and an account lockout after repeated failures |
| Two-step code | 20 attempts a minute |
| Forgot password | 5 requests a minute |
| New password | 10 attempts a minute |
| Resend confirmation email | 3 requests in 10 minutes |

## Related

* [Profile and security](hb://guides/portal-profile-and-security)
* [Create your account](hb://guides/portal-create-your-account)
* [FAQ and troubleshooting](hb://guides/portal-faq-and-troubleshooting)
