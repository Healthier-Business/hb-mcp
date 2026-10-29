# Development and publishing

Maintainer notes for `@healthier-business/hub-mcp`. Not shipped in the npm package.

## Development

```sh
npm install
npm run generate                      # spec/hub-v2.json -> generated/ (catalogue + events)
npm run build                         # generate + tsc to dist/
npm test                              # vitest; mock Hub built from the spec, no real network
npm run typecheck && npm run lint
npx tsx scripts/demo-transcript.ts    # built server over stdio with a real MCP client against the mock Hub
npm run spec:refresh -- /path/to/hub-v2.json [guides-dir portals-dir]
```

The tool catalogue is built from the bundled spec at build time and a test fails if `generated/` and `spec/hub-v2.json` disagree. To take a new Hub spec: `npm run spec:refresh -- <path>`, `npm test`, commit.

Layout: `src/` (config, catalogue, http, tokens, safety, errors, execute, output, tools, resources, prompts, server, cli), `spec/`, `generated/`, `content/` (bundled guides and portal docs), `claude-plugin/`, `examples/`, `test/`, `docs/design.md`.

## Publishing

Run `npm run build && npm test`, bump the version (`npm version patch`), check `npm pack --dry-run`, then `npm publish` (npm asks for 2FA). The package is public under the `@healthier-business` npm organisation.
