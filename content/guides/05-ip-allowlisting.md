# IP allowlisting

An IP allowlist is an optional extra lock on an API key. When a key has an allowlist, the API accepts calls made with that key only from the addresses on the list. A thief who copies your key cannot use it from anywhere else. Allowlisting is a good choice whenever your integration calls the API from a server with a fixed public address, and it costs nothing to switch on.

## How it works

Every key has an allowed-IP list, and by default the list is empty. An empty list means "any address". As soon as you add one entry, calls from every other address are refused.

An entry is one of these:

- a single IPv4 address, such as `203.0.113.25`;
- a single IPv6 address, such as `2001:db8::25`;
- an IPv4 range in CIDR notation, such as `203.0.113.0/24`, with a prefix length from 0 to 32;
- an IPv6 range in CIDR notation, such as `2001:db8::/32`, with a prefix length from 0 to 128.

A key may have **at most 20 entries**. If you need more than that, use ranges. Anything that is not a valid address or range is rejected when you save the key, with the message "Enter an IP address or a range such as 203.0.113.0/24." Note that `/0` is a valid range that matches every address, which defeats the purpose, so do not use it.

You manage the list on the Developer page in the Hub, in the key's form. The field takes entries separated by commas or spaces. Under the field the page shows the address your browser is connecting from, with an **Add my IP** button that appends it to the list.

## Where the list is checked

The API checks the allowlist in three places:

1. When you exchange the key for a token (`POST /auth/token`).
2. When you refresh a token (`POST /auth/refresh`).
3. On **every call** that carries a bearer token.

The third point has a consequence worth remembering. Because the check happens on every call and not only when the token was issued, a change to the list takes effect immediately for tokens you already hold. If you add an entry that excludes your server, the very next call from your server is refused, even though its token is still valid. If you remove the restriction, calls start working again at once with the same tokens. You do not need to wait for tokens to expire or obtain new ones.

Regenerating a key keeps its allowlist. The new key has the same list as the old one.

## The error

A call from an address that is not on the list is refused with `403` and the code `ip_not_allowed`:

```json
{
  "error": "ip_not_allowed",
  "message": "This IP address is not allowed for the API key.",
  "request_id": "01JAQ0Y8Z3N5W6V7B2K4M9D1XC"
}
```

Retrying does not help, because nothing about the request will change. Treat it as a configuration error: log it, alert someone, and stop retrying until the address or the list changes. The same code is used by all three checks above.

The message does not tell you which address the API saw. To find out, ask the machine that makes the calls, as in the next section.

## Setting it up

Work through these steps for a new allowlist.

1. **Find the public address your server calls from.** This is the address the Hub sees, which is the address of the outermost gateway your traffic leaves through. It is often not the address of the machine itself. On the server that will make the calls, run `curl https://api.ipify.org` (or any similar "what is my address" service). If your connection can use IPv6, the answer can be an IPv6 address, so ask `curl --ipv4 ...` and `curl --ipv6 ...` separately to see both.
2. **Add the addresses** to the key on the Developer page, one entry for each address or range that may call.
3. **Test from the server** with a call to `GET /auth/me`. It should succeed.
4. **Test from somewhere else** (see below). It should fail with `ip_not_allowed`.

Do not rely on the **Add my IP** button for your server's address. The button shows the address of the browser you are using to edit the key, which is usually your office or home connection, not your server.

### Proxies, gateways and cloud hosting

The most common allowlisting problems come from outbound traffic that does not leave from one fixed address.

- **NAT gateways and firewalls.** Many hosts send outbound traffic through a shared gateway. Allow that gateway's public address, and make sure it is a fixed (static) address, not one that can change.
- **Serverless platforms and some container hosts.** Outbound addresses may be shared with other customers or change over time. An allowlist is unreliable there unless the platform offers a fixed outbound address, and a shared address defeats the point of the list. If you cannot get a fixed address, leave the list empty and rely on a narrowly scoped key with an expiry date instead.
- **Several servers.** Allow every server that calls, or the range they share. Add the new address before you move traffic, then remove the old one afterwards.
- **IPv4 and IPv6.** The address the Hub sees depends on which one your connection used. If you allowed only an IPv4 address and your server sometimes connects over IPv6, some calls will be refused. Allow both, or make your HTTP client prefer IPv4.
- **Corporate proxies.** If your service reaches the internet through an outbound proxy, the Hub sees the proxy's address, not your server's.

Webhooks go the other way: Hub calls your URL. The allowlist on a key does not affect them, and at the time of writing there is no published list of the addresses Hub sends webhooks from. Do not build a firewall rule around the sender's address. Verify the signature of each delivery instead, as described in [webhooks](10-webhooks.md).

## Testing from a different address

To prove the list works, make a call from an address that is not on it and check that you get `ip_not_allowed`. Any of these will do:

- run the call from your laptop on a home or mobile connection, when the key allows only your server;
- run it from a second server that is not on the list;
- temporarily remove your server's address from the list, call, and add it back (the change is effective at once).

Test the exchange as well as an ordinary call, since both are checked. The sandbox of the HB developer portal is planned to be able to switch the same check on, so that you can test your error handling without touching your production key. See [testing and sandbox](12-testing-and-sandbox.md).

## Recovering from a lock-out

The allowlist applies only to calls to the API. It does not apply to people using the Hub in a browser, so if you lock your integration out you can always sign in to the Hub, open the Developer page and edit the key. Fix the list and the integration starts working again on its next call.

## Samples

The first sample finds your outbound address and shows what an `ip_not_allowed` answer looks like. The others validate a list of entries before you paste it into the key form, using the same rules as the Hub: an address or a CIDR range, a prefix of at most 32 (IPv4) or 128 (IPv6), and at most 20 entries.

### cURL

```bash
# The public address your calls leave from, for IPv4 and IPv6 if available.
curl --silent --ipv4 https://api.ipify.org; echo
curl --silent --ipv6 https://api.ipify.org || echo '(no IPv6 route)'

# A token exchange from an address that is not on the key's list.
curl --silent --write-out '\nHTTP status: %{http_code}\n' \
  "https://hub.hbcompliance.co.uk/api/v2/auth/token" \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data "{\"api_key\": \"$HB_API_KEY\"}"
```

### JavaScript

```javascript
import net from 'node:net';

const MAX_ENTRIES = 20;

function problemWith(entry) {
  const [address, prefix = null, ...rest] = entry.split('/');
  const family = net.isIP(address);

  if (rest.length > 0 || family === 0) {
    return 'Enter an IP address or a range such as 203.0.113.0/24.';
  }

  if (prefix !== null) {
    const limit = family === 6 ? 128 : 32;

    if (!/^\d+$/.test(prefix) || Number(prefix) > limit) {
      return 'Enter an IP address or a range such as 203.0.113.0/24.';
    }
  }

  return null;
}

export function validateAllowlist(text) {
  const entries = text.split(/[\s,]+/).filter(Boolean);
  const problems = entries.flatMap((entry) => {
    const problem = problemWith(entry);
    return problem ? [`${entry}: ${problem}`] : [];
  });

  if (entries.length > MAX_ENTRIES) {
    problems.push(`Too many entries: ${entries.length} (the limit is ${MAX_ENTRIES}).`);
  }

  return { entries, problems };
}

const { entries, problems } = validateAllowlist('203.0.113.25, 203.0.113.0/24 2001:db8::/32 999.1.1.1 10.0.0.0/33');

console.log('Entries:', entries);
console.log('Problems:', problems);
```

### PHP

```php
<?php

const MAX_ENTRIES = 20;

function allowlist_problem(string $entry): ?string
{
    $parts = explode('/', $entry);
    $address = $parts[0];
    $prefix = $parts[1] ?? null;
    $isIpv6 = str_contains($address, ':');
    $validPrefix = $prefix === null || (ctype_digit($prefix) && (int) $prefix <= ($isIpv6 ? 128 : 32));

    if (count($parts) > 2 || filter_var($address, FILTER_VALIDATE_IP) === false || ! $validPrefix) {
        return 'Enter an IP address or a range such as 203.0.113.0/24.';
    }

    return null;
}

/** @return array{entries: list<string>, problems: list<string>} */
function validate_allowlist(string $text): array
{
    $entries = array_values(array_filter(preg_split('/[\s,]+/', $text) ?: [], fn (string $entry): bool => $entry !== ''));
    $problems = [];

    foreach ($entries as $entry) {
        $problem = allowlist_problem($entry);

        if ($problem !== null) {
            $problems[] = "{$entry}: {$problem}";
        }
    }

    if (count($entries) > MAX_ENTRIES) {
        $problems[] = sprintf('Too many entries: %d (the limit is %d).', count($entries), MAX_ENTRIES);
    }

    return ['entries' => $entries, 'problems' => $problems];
}

$result = validate_allowlist('203.0.113.25, 203.0.113.0/24 2001:db8::/32 999.1.1.1 10.0.0.0/33');

echo 'Entries: ', implode(' ', $result['entries']), "\n";
echo "Problems:\n", implode("\n", $result['problems']), "\n";
```

### Python

```python
import ipaddress
import re

MAX_ENTRIES = 20
MESSAGE = "Enter an IP address or a range such as 203.0.113.0/24."


def problem_with(entry):
    address, _, prefix = entry.partition("/")

    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return MESSAGE

    if "/" in entry:
        limit = 128 if parsed.version == 6 else 32
        if not prefix.isdigit() or int(prefix) > limit:
            return MESSAGE

    return None


def validate_allowlist(text):
    entries = [entry for entry in re.split(r"[\s,]+", text) if entry]
    problems = []

    for entry in entries:
        problem = problem_with(entry)
        if problem:
            problems.append(f"{entry}: {problem}")

    if len(entries) > MAX_ENTRIES:
        problems.append(f"Too many entries: {len(entries)} (the limit is {MAX_ENTRIES}).")

    return entries, problems


entries, problems = validate_allowlist("203.0.113.25, 203.0.113.0/24 2001:db8::/32 999.1.1.1 10.0.0.0/33")
print("Entries:", entries)
print("Problems:", problems)
```

The expected problems in all three are `999.1.1.1` (not an address) and `10.0.0.0/33` (prefix too long). The other three entries are valid.

## Summary of advice

Allowlist when your calls come from fixed addresses, and test both a call that should pass and one that should fail. Prefer a short list of ranges to a long list of single addresses. Keep the list in step with your infrastructure, and add the new address before you retire the old one. Remember that an allowlist is a second lock: keep the key secret as well, and see [authentication](02-authentication.md) for the rest of the security advice.
