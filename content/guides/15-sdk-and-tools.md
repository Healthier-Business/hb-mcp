# SDKs and tools

This page covers the tools around the API. First comes what is planned but does not exist yet. Then comes what you can use today, which is the OpenAPI specification.

## Planned, not available yet

Everything in this section is a plan. None of it has been released, and details such as package names may change. Do not build on it yet. The guides in this folder show how to call the API directly, in cURL, JavaScript, PHP and Python, and that is the supported way to integrate today.

### Software development kits

We plan one official library for each of three languages, with the same shape in all of them and versions that follow the API:

| Language | Planned package | Planned notes |
| --- | --- | --- |
| JavaScript and TypeScript | `@healthier-business/sdk` | Full types, works in Node and in edge runtimes |
| PHP | `healthier-business/sdk` on Composer | Typed objects, for PHP 8.2 or later |
| Python | `healthier-business` on PyPI | Typed models, with both synchronous and asynchronous clients |

The names above are proposals and are not final. The libraries are planned to take care of the work these guides show you how to do by hand: exchanging the key, caching and refreshing tokens, retrying once after `invalid_token`, switching between sandbox and production, iterating over every page of a list, sending an `Idempotency-Key` on creating calls, retrying `429` and `5xx` answers with `Retry-After`, raising a separate error type for each error code, and verifying webhook signatures with a ready-made helper.

### Zapier

A Zapier integration called "Healthier Business" is planned. It would sign in with an API key and check it with `GET /auth/me`. Its triggers would use the webhooks of the API: Zapier would register its own address with `POST /webhooks` for the events you choose and remove it with `DELETE /webhooks/{id}`. Its actions would include creating an occupational health request, assigning online training and creating or cancelling a booking. It will need a Zapier developer account and Zapier's review before it can be published.

### Plugins for coding assistants

Plugins are planned for Claude Code, Cursor and Codex, to help an engineer's coding assistant build an integration correctly against this API. They are planned to share one server that exposes the API's operations as tools, taken from the OpenAPI specification, and to carry guidance such as: use the sandbox first, never log keys, always verify webhook signatures, use idempotency keys, and handle `ip_not_allowed` and `insufficient_credits`. They are planned to default to a sandbox key and to refuse to use a production key unless you configure them to.

Until then, you can give your coding assistant the OpenAPI file described below and these guides, which carry the same advice.

## The OpenAPI specification

The API is described by an OpenAPI 3.1 document, `hub-v2.json`. It is generated from the code that serves the API, so it describes what the API really does. It covers all of `/api/v2`: 163 paths, 186 operations and the 59 webhook events. For every operation it gives the summary and description, the parameters, the request body and the responses, including the errors.

Some features of the document are worth knowing:

- **Servers.** The production server is `https://hub.hbcompliance.co.uk`, and every path in the document starts with `/api/v2`. When a tool asks for a base URL, give it the server address, not the address plus `/api/v2`, or the paths will be wrong. The document also lists a sandbox server whose host is a placeholder, because sandboxes are not open yet (see [testing and sandbox](12-testing-and-sandbox.md)). Change it when they are.
- **Security.** There is one security scheme, a bearer token, as the document explains. The tools below cannot exchange the key for a token by themselves, so you call `POST /auth/token` yourself, or in your own code, and give the tool the access token. A token lasts 60 minutes.
- **Scopes.** Each operation names the scope a key needs in an extension field, `x-required-scope`, for example `hub:candidates:read`. The Scopes guide explains the format.
- **Tags.** Operations are tagged by portal: Authentication, Account, Hub (core), Online Training, Occupational Health, Practical Training, Virtual BLS Training, Clinical Interviews, Clinical Appraisals, References, Registration Monitoring, and DBS and Right To Work.
- **Operation ids.** Every operation has a unique `operationId` in dotted form, such as `hub.candidates.list` or `auth.token.create`. Code generators turn these into method names.
- **Webhooks.** The document has a `webhooks` section, with one entry for each event and the shape of its `data`. Each event is named as in these guides, for example `online-training.course.completed`.

### Using it with a code generator

A generator reads the document and writes a client library for a language. Several tools do this, including OpenAPI Generator and a number of commercial services. For example, with OpenAPI Generator installed:

```bash
openapi-generator-cli generate \
  --input-spec hub-v2.json \
  --generator-name typescript-fetch \
  --output ./hub-client
```

We have not tested any particular generator against this document. Support for OpenAPI 3.1 differs between generators and between their versions, so check that yours supports it. Read what the generator produces before you rely on it. Whatever you generate, keep the hand-written parts that the document cannot give you: the token manager from [authentication](02-authentication.md), retry and backoff, pagination by `links.next`, idempotency keys, and webhook verification. A generated client covers the shapes of requests and responses, and not those behaviours.

### Using it with Postman or Insomnia

Both tools can import an OpenAPI document and turn every operation into a request you can send. In outline:

1. Import `hub-v2.json`. In Postman, choose Import and pick the file. In Insomnia, create a new collection from an import.
2. Create an environment with a variable for the base URL, set to `https://hub.hbcompliance.co.uk`, and one for the access token.
3. Call `POST /api/v2/auth/token` with your key in the body. Copy `access_token` from the answer into the token variable, or script that step. Set the collection's authorisation to a bearer token that uses the variable.
4. Send requests. Remember that a token lasts 60 minutes, so repeat step 3 when it runs out.

We have not checked the import in every version of these tools, and their handling of OpenAPI 3.1 depends on the version. If an import fails, check the tool's documentation for its OpenAPI version support.

Treat your key like a password here too. Do not store it in a shared collection or an exported environment file.

### A sample: list the operations a key can call

The samples below read `hub-v2.json` and print every operation with the scope it needs. If you pass your key's scopes as extra arguments, they print only the operations those scopes cover, using the same rule as the API: `*` covers everything, `{portal}:*` covers a portal, and a `:write` scope covers the matching `:read`. This is a quick way to see what a key can do before you create it. The scope list of a real key is shown by `GET /auth/me`.

Pass the path of the file as the first argument, for example `hub-v2.json`, and then any scopes, for example `hub:candidates:write online-training:results:read`.

### cURL

This needs `jq`. It lists every operation with its scope. Filtering by scope is easier in the other languages.

```bash
SPEC="${1:?Usage: $0 hub-v2.json}"

jq --raw-output '
  .paths | to_entries[] | .key as $path
  | .value | to_entries[]
  | select(.value | type == "object" and has("operationId"))
  | [(.key | ascii_upcase), $path, (.value["x-required-scope"] // "none"), .value.operationId]
  | @tsv' "$SPEC" | sort -k2,2 -k1,1
```

### JavaScript

```javascript
import { readFileSync } from 'node:fs';

const [specPath, ...heldScopes] = process.argv.slice(2);

if (!specPath) {
  throw new Error('Usage: node operations.mjs hub-v2.json [scope ...]');
}

function covers(granted, needed) {
  if (granted.includes('*') || granted.includes(needed)) {
    return true;
  }
  if (needed.endsWith(':read') && granted.includes(`${needed.slice(0, -':read'.length)}:write`)) {
    return true;
  }
  return granted.includes(`${needed.split(':')[0]}:*`);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const rows = [];

for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (typeof operation !== 'object' || !operation.operationId) {
      continue;
    }

    const scope = operation['x-required-scope'] ?? null;

    if (heldScopes.length === 0 || scope === null || covers(heldScopes, scope)) {
      rows.push([method.toUpperCase(), path, scope ?? 'none', operation.operationId]);
    }
  }
}

rows.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

for (const row of rows) {
  console.log(row.join('\t'));
}

console.error(`${rows.length} of ${Object.values(spec.paths).flatMap((item) => Object.values(item)).filter((o) => o.operationId).length} operations`);
```

### PHP

```php
<?php

$specPath = $argv[1] ?? null;
$heldScopes = array_slice($argv, 2);

if ($specPath === null) {
    exit("Usage: php operations.php hub-v2.json [scope ...]\n");
}

/** @param list<string> $granted */
function covers(array $granted, string $needed): bool
{
    if (in_array('*', $granted, true) || in_array($needed, $granted, true)) {
        return true;
    }

    if (str_ends_with($needed, ':read') && in_array(substr($needed, 0, -strlen(':read')) . ':write', $granted, true)) {
        return true;
    }

    return in_array(explode(':', $needed)[0] . ':*', $granted, true);
}

$spec = json_decode((string) file_get_contents($specPath), true, 512, JSON_THROW_ON_ERROR);
$rows = [];
$total = 0;

foreach ($spec['paths'] as $path => $item) {
    foreach ($item as $method => $operation) {
        if (! is_array($operation) || ! isset($operation['operationId'])) {
            continue;
        }

        $total++;
        $scope = $operation['x-required-scope'] ?? null;

        if ($heldScopes === [] || $scope === null || covers($heldScopes, $scope)) {
            $rows[] = [strtoupper($method), $path, $scope ?? 'none', $operation['operationId']];
        }
    }
}

usort($rows, fn (array $a, array $b): int => [$a[1], $a[0]] <=> [$b[1], $b[0]]);

foreach ($rows as $row) {
    echo implode("\t", $row), "\n";
}

fwrite(STDERR, count($rows) . " of {$total} operations\n");
```

### Python

```python
import json
import sys

if len(sys.argv) < 2:
    sys.exit("Usage: python3 operations.py hub-v2.json [scope ...]")

spec_path, held_scopes = sys.argv[1], sys.argv[2:]


def covers(granted, needed):
    if "*" in granted or needed in granted:
        return True
    if needed.endswith(":read") and needed[: -len(":read")] + ":write" in granted:
        return True
    return needed.split(":")[0] + ":*" in granted


with open(spec_path, encoding="utf-8") as handle:
    spec = json.load(handle)

rows = []
total = 0

for path, item in spec["paths"].items():
    for method, operation in item.items():
        if not isinstance(operation, dict) or "operationId" not in operation:
            continue

        total += 1
        scope = operation.get("x-required-scope")

        if not held_scopes or scope is None or covers(held_scopes, scope):
            rows.append((method.upper(), path, scope or "none", operation["operationId"]))

for row in sorted(rows, key=lambda r: (r[1], r[0])):
    print("\t".join(row))

print(f"{len(rows)} of {total} operations", file=sys.stderr)
```

The output has one line for each operation, in the form `GET	/api/v2/hub/candidates	hub:candidates:read	hub.candidates.list`, separated by tabs.

## Where to go next

If you are starting a new integration, begin with [getting started](01-getting-started.md). If you are looking for a particular endpoint, the portal pages in [the portals folder](../portals/) describe each portal in turn.
