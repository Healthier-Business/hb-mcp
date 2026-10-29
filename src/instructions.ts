import type { Config } from './config.js';
import { writesEnabled } from './config.js';

/** Short guide the model reads at connect time. */
const TASK_JOBS: [string, string][] = [
  ['hb_find_candidate', 'find a person by name, email or reference'],
  ['hb_candidate_overview', 'one line per record across the portals the key can reach; health data only as statuses and dates'],
  ['hb_training_progress', "a candidate's online training"],
  ['hb_list_bookings', 'bookings across the booking portals'],
  ['hb_credits', 'credit balances and recent transactions'],
  ['hb_account_summary', 'key, credits and webhook health in one answer'],
  ['hb_needs_attention', 'what needs action now'],
  ['hb_monitoring_alerts', 'DBS/RTW, registration and occupational health alerts'],
  ['hb_worker_status', 'a monitored worker and the latest check'],
  ['hb_billing_summary', 'monitoring usage and bills'],
  ['hb_get_report', 'certificate and report details and how to download them'],
  ['hb_webhook_health', 'failing webhook endpoints and deliveries'],
  ['hb_go_live_check', 'readiness report before going live'],
  ['hb_book_practical_training', 'book or invite for practical training'],
  ['hb_book_slot', 'book a virtual BLS slot, clinical interview or appraisal'],
  ['hb_change_booking', 'cancel or reschedule a booking'],
  ['hb_invite_to_practical', 'practical training invitations'],
  ['hb_save_candidate', 'create or update a candidate without duplicates'],
  ['hb_assign_training', 'assign online courses'],
  ['hb_request_references', 'ask for references'],
  ['hb_request_occupational_health', 'request occupational health clearance (no health answers handled)'],
  ['hb_chase_outstanding', 'send reminders and extend or cancel reference requests'],
  ['hb_verify_worker', 'add and verify a DBS/RTW or registration worker'],
  ['hb_acknowledge_alerts', 'acknowledge or dismiss alerts'],
  ['hb_bulk_import_workers', 'import workers from a CSV (preview first)'],
  ['hb_setup_sandbox_webhook', 'create a sandbox webhook, test it (never shows the secret)'],
  ['hb_redeliver_webhooks', 'redeliver failed webhooks'],
  ['hb_rotate_webhook_secret', 'rotate a webhook secret (never shows it)'],
  ['hb_verify_certificate', 'verify a training certificate file (checks the file and price first; never shows its contents)'],
  ['hb_verification_status', 'follow certificate verifications: status, result, timeline, report and certificate availability'],
];

export function buildInstructions(config: Config, opCount: number, eventCount: number, taskToolNames: string[] = []): string {
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
  const offered = new Set(taskToolNames);
  const jobs = TASK_JOBS.filter(([name]) => offered.has(name)).map(([name, job]) => `${name} (${job})`);
  const tasks = jobs.length
    ? `Task tools do the common jobs in one call with sensible defaults, through the same safety pipeline as hb_call_operation (read-only default, plan-then-confirm, idempotency, secret redaction); prefer them when they match, and each result lists the operation ids it called. Every task tool that writes is two calls: the first returns the options or plan and sends nothing, the second needs confirm=true after the user agrees; they are hidden while the server is read-only. Which tool for which job: ${jobs.join('; ')}. Use the generic tools for everything else. HB_TASK_TOOLS (all, core or none) chooses which task tools are offered.`
    : 'No task tools are offered (HB_TASK_TOOLS=none): use the generic tools.';
  const uploads = offered.has('hb_verify_certificate')
    ? `hb_verify_certificate reads one local certificate file (.pdf, .jpg, .jpeg or .png) by absolute path, only inside the folders listed in HB_UPLOAD_DIRS (default: the server's working directory only; ${config.uploadDirs.join(', ')} now). Hidden files, links that leave those folders, wildcards and other file types are refused. A certificate is personal data: never print, paste or summarise its contents or base64; show only its name, size and SHA-256. If the file is refused, tell the user to move it into an allowed folder or ask the owner to add one; never try another path to get around it.`
    : undefined;
  const noBaseUrl =
    !config.apiKey && config.modeSource === 'default'
      ? 'No sandbox base URL (HB_BASE_URL) is set, so this server points at the default LIVE Hub. Someone building or learning should use a sandbox: hb://guides/portal-sandboxes shows how to create one and where its base address is.'
      : undefined;
  const setup = config.apiKey
    ? undefined
    : 'NOT CONFIGURED: no HB_API_KEY is set, so Hub calls will fail. Do not ask for a key in chat. Tell the user to get one from the developer portal and walk them through it with hb://guides/portal-create-your-account (sign up with a work email and verify it) and hb://guides/portal-sandboxes (create a sandbox), then hb://guides/portal-api-keys-and-tokens (create a test key); the get-started-in-sandbox prompt does this step by step. They put the key in HB_API_KEY and the sandbox address in HB_BASE_URL in the MCP server config, then restart.';
  return [
    ...(setup ? [setup] : []),
    ...(noBaseUrl ? [noBaseUrl] : []),
    `Healthier Business Hub API v2 (${opCount} operations). Environment: ${env}. ${writes}`,
    tasks,
    ...(uploads ? [uploads] : []),
    how,
    'People are addressed only by candidate_ref (a uuid); never by internal id, and never invent one: list or search candidates first. A candidate reference of the client\'s own (candidate_reference) is different from candidate_ref.',
    'Scopes: each operation needs a scope like occupational-health:requests:read (a :write scope also grants :read). 403 insufficient_scope means the key lacks it; tell the user which scope to add. Do not try other endpoints to work around it.',
    'Lists are paginated (page, per_page up to 100, default 25). Prefer filters and the `fields` argument to keep answers small; use all_pages only when you need everything.',
    'Money is integer pence with a currency; credits are units, not money. Some operations use credits or balance: say so before running them.',
    'Responses marked health_data contain special-category health information: use only what the task needs and do not repeat it elsewhere.',
    'Secrets: the API key lives only in the server environment (HB_API_KEY). Never ask the user to paste a key, token or webhook secret in chat, and never print one.',
    'Sandbox first: build and test in a sandbox, go live only after the user asks (see the go-live-checklist prompt). Quote request_id when reporting an error.',
    'Docs are available as resources: hb://guides/<name> (authentication, errors, scopes-and-permissions, ...), hb://portals/<toolset>, hb://spec/operations/<id>, hb://spec/events/<type>. hb_search_guides finds the right guide by words.',
    'The developer portal (where a developer signs up, makes sandboxes, test keys and webhooks, uses the API Playground and request log, books support and goes to production) has its own guides: hb://guides/portal-overview, portal-create-your-account, portal-sandboxes, portal-api-keys-and-tokens, portal-webhooks, portal-simulate, portal-api-playground, portal-request-log-and-debugging, portal-support-and-booking-a-call, portal-go-to-production, and more. Use them when the user asks how to do something in the portal, not only about the API.',
  ].join('\n\n');
}
