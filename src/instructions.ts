import type { Config } from './config.js';
import { writesEnabled } from './config.js';

/** Short guide the model reads at connect time. */
export function buildInstructions(config: Config, opCount: number, eventCount: number): string {
  const env = config.mode === 'live' ? 'LIVE (real people, real data, real credits)' : 'SANDBOX (synthetic data; nothing real is touched)';
  const writes = writesEnabled(config)
    ? config.mode === 'live'
      ? 'Writes are enabled on the LIVE Hub. Every write first returns a plan and sends nothing; show it to the user and repeat with confirm=true only after they say yes.'
      : 'Writes are enabled in this sandbox.'
    : 'The server is read-only: only GET operations run. Writes are refused until the owner sets HB_READ_ONLY=false (and, for live, HB_ALLOW_LIVE_WRITES=true).';
  const how =
    config.toolMode === 'compact'
      ? `Workflow: hb_status first; then hb_search_operations to find an operation, hb_describe_operation to read its exact shape, hb_call_operation to run it. hb_list_events / hb_describe_event explain the ${eventCount} webhook events; hb_verify_webhook_signature checks a delivery locally.`
      : `Each Hub operation is its own tool (name = operation id with underscores, e.g. hub_candidates_list). hb_status shows who you are; hb_list_events / hb_describe_event explain the ${eventCount} webhook events.`;
  return [
    `Healthier Business Hub API v2 (${opCount} operations). Environment: ${env}. ${writes}`,
    how,
    'People are addressed only by candidate_ref (a uuid); never by internal id, and never invent one: list or search candidates first. A candidate reference of the client\'s own (candidate_reference) is different from candidate_ref.',
    'Scopes: each operation needs a scope like occupational-health:requests:read (a :write scope also grants :read). 403 insufficient_scope means the key lacks it; tell the user which scope to add. Do not try other endpoints to work around it.',
    'Lists are paginated (page, per_page up to 100, default 25). Prefer filters and the `fields` argument to keep answers small; use all_pages only when you need everything.',
    'Money is integer pence with a currency; credits are units, not money. Some operations use credits or balance: say so before running them.',
    'Responses marked health_data contain special-category health information: use only what the task needs and do not repeat it elsewhere.',
    'Secrets: the API key lives only in the server environment (HB_API_KEY). Never ask the user to paste a key, token or webhook secret in chat, and never print one.',
    'Sandbox first: build and test in a sandbox, go live only after the user asks (see the go-live-checklist prompt). Quote request_id when reporting an error.',
    'Docs are available as resources: hb://guides/<name> (authentication, errors, scopes-and-permissions, ...), hb://portals/<toolset>, hb://spec/operations/<id>, hb://spec/events/<type>.',
  ].join('\n\n');
}
