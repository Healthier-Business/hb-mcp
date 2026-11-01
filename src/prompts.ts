import type { AppContext } from './context.js';
import { writesEnabled } from './config.js';

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
  build: (args: Record<string, string>) => string;
}

export function buildPrompts(ctx: AppContext): PromptDefinition[] {
  const compact = ctx.config.toolMode === 'compact';
  const call = (id: string) => (compact ? `hb_call_operation (operation_id "${id}")` : `the \`${id.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}\` tool`);
  const env = ctx.config.mode.toUpperCase();
  const writeLine = writesEnabled(ctx.config)
    ? ctx.config.mode === 'live'
      ? 'Writes are enabled on the LIVE Hub: show the plan from the first call and wait for the user\'s yes before confirm=true.'
      : 'Writes are enabled in this sandbox.'
    : 'The server is read-only, so stop and tell the user what would be needed (HB_READ_ONLY=false, preferably in a sandbox) instead of trying to write.';

  return [
    {
      name: 'book-practical-training',
      title: 'Book a practical training for a candidate',
      description: 'Find the candidate, a course, a session with free places, check credits, then book (with a plan first in live).',
      arguments: [
        { name: 'candidate', description: 'Candidate name, email or candidate_ref.', required: true },
        { name: 'course', description: 'Course name or id (optional).', required: false },
        { name: 'dates', description: 'Preferred date range (optional).', required: false },
      ],
      build: (a) =>
        [
          `Book a practical training for: ${a.candidate}${a.course ? `, course: ${a.course}` : ''}${a.dates ? `, dates: ${a.dates}` : ''}. Environment: ${env}. ${writeLine}`,
          'Prefer the task tools: hb_find_candidate to find the person, then hb_book_practical_training (call 1 returns session options and the plan and sends nothing; call 2 with event_id, pay_option, the agency contact and confirm=true books). The generic steps below are the fallback.',
          '1. hb_status (or the status tool) to confirm environment and that the key has practical-training:bookings:write and hub:candidates:read.',
          `2. Find the candidate with ${call('hub.candidates.list')} using query {"search": "..."}; take their candidate_ref. If several match, ask the user which one. Never guess a candidate_ref.`,
          `3. ${call('practical-training.courses.list')} to find the course; ${call('practical-training.events.list')} with available_only=true and a date range to find sessions with free places; ${call('practical-training.locations.list')} if location matters.`,
          `4. ${call('practical-training.credits.show')}: check booking credits and balance. Credits are units; the balance is pence.`,
          `5. Describe the booking operation (practical-training.bookings.create) to see pay_option choices and required fields. Optionally hold a place first (practical-training.events.hold).`,
          `6. Summarise: candidate, course, session, date, location, pay_option and what it costs. Ask the user to confirm.`,
          `7. Create the booking with ${call('practical-training.bookings.create')}. In live the first call returns a plan; repeat with confirm=true after approval. Report the booking id and request_id.`,
        ].join('\n'),
    },
    {
      name: 'check-candidate-compliance',
      title: "Check a candidate's compliance",
      description: 'Read-only: gather a candidate\'s compliance status across Hub, Occupational Health and Online Training.',
      arguments: [{ name: 'candidate', description: 'Candidate name, email or candidate_ref.', required: true }],
      build: (a) =>
        [
          `Check the compliance picture for: ${a.candidate}. Environment: ${env}. This is read-only; do not write anything.`,
          'Prefer the task tools: hb_find_candidate, then hb_candidate_overview (one line per record across the portals the key can reach). The steps below are the fallback.',
          `1. Find them: ${call('hub.candidates.list')} with {"search": "..."}; confirm the right person if several match.`,
          `2. ${call('hub.candidates.show')} with path_params {"candidate_ref": "..."}: compliance_status, next_expiry_date, roles.`,
          `3. If the key has the scopes, also: ${call('occupational-health.candidates.show')} (health clearance; marked health_data, use only what is needed) and ${call('online-training.candidates.results')} (course results) and ${call('online-training.candidates.modules')}.`,
          '4. If a call answers 403 insufficient_scope or portal_unavailable, say which part could not be checked and why; do not work around it.',
          '5. Report: overall status, anything expired or expiring soon (with dates), what is missing, and suggested next steps. Do not repeat health details beyond what the user asked.',
        ].join('\n'),
    },
    {
      name: 'webhook-sandbox-setup',
      title: 'Set up and test a webhook in a sandbox',
      description: 'Register a webhook endpoint in a SANDBOX, choose events, send a test event, check deliveries and verify signatures.',
      arguments: [
        { name: 'endpoint_url', description: 'HTTPS URL that will receive events.', required: true },
        { name: 'events', description: 'Comma-separated event types, or a portal name (optional).', required: false },
      ],
      build: (a) =>
        [
          `Set up a webhook to ${a.endpoint_url}${a.events ? ` for: ${a.events}` : ''}. Environment: ${env}.`,
          ctx.config.mode === 'live'
            ? 'WARNING: this server points at the LIVE Hub. Registering a webhook there is a real change. Recommend a sandbox (HB_BASE_URL) first, and only continue on live if the user explicitly asks.'
            : 'This is a sandbox: safe to experiment.',
          writeLine,
          'Prefer hb_setup_sandbox_webhook (sandbox only): it creates the endpoint, sends a test event and reports the delivery without showing the signing secret. The steps below are the fallback.',
          `1. Choose events: ${compact ? 'hb_list_events and hb_describe_event' : 'the hb_list_events and hb_describe_event tools'}; also ${call('webhooks.events.list')} for the events your key can receive.`,
          `2. Create the endpoint with ${call('webhooks.endpoints.create')} (describe it first). The signing secret is shown ONCE in the answer: tell the user to store it as HB_WEBHOOK_SECRET in their own environment; do not repeat it in chat.`,
          `3. Send a test event: ${call('webhooks.endpoints.test')}; then ${call('webhooks.deliveries.list')} to see the result and status codes.`,
          `4. Verify a delivery locally with hb_verify_webhook_signature (raw body, X-Hub-Timestamp, X-Hub-Signature); window is 300 seconds. Dedupe on X-Hub-Event-Id.`,
          '5. If deliveries fail, remember: up to 5 attempts (60s, 5m, 15m, 1h), and an endpoint failing 25 times in a row is switched off. Redeliver with webhooks.deliveries.redeliver after fixing.',
        ].join('\n'),
    },
    {
      name: 'get-started-in-sandbox',
      title: 'Get started in a sandbox',
      description: 'Walk a new developer from sign-up to a first read call: work email, verify, sandbox, API key, HB_BASE_URL/HB_API_KEY, --doctor, first read.',
      arguments: [],
      build: () =>
        [
          `Walk the new developer through getting started, one step at a time, waiting for them to finish each step. Current environment: ${env} (${ctx.config.baseUrl}); ${ctx.tokens.hasKey ? 'a key is configured' : 'no HB_API_KEY is configured yet'}. Never ask them to paste a key, token or secret in chat.`,
          '1. Sign up on the developer portal with a WORK email address (Gmail, Yahoo, Apple Mail and disposable addresses are refused), then confirm it with the link in the email (valid 3 days; check spam). Guides: hb://guides/portal-create-your-account, hb://guides/portal-verify-your-email. Overview: hb://guides/portal-overview.',
          '2. In the console choose Sandboxes, then New sandbox, and name it (2 to 120 characters). Copy its base address. Guide: hb://guides/portal-sandboxes.',
          '3. In the console choose API keys, pick the sandbox, choose New key. Prefer Read only or Custom access for a first run. The key is shown once ("Copy it now"): they store it in their own secret store. Guide: hb://guides/portal-api-keys-and-tokens.',
          '4. They set HB_BASE_URL (the sandbox base address) and HB_API_KEY in the MCP server config (or shell), keep HB_READ_ONLY=true, and restart the client. See the README quickstart for their client.',
          '5. They run `npx -y @healthier-business/hub-mcp --doctor` in the same environment: it should say SANDBOX, token exchange succeeded and list the scopes.',
          `6. Run hb_status to confirm environment and scopes, then a first read: ${call('hub.candidates.list')} (needs hub:candidates:read), and explain the answer (candidate_ref, pagination).`,
          '7. Suggest next steps: hb://guides/portal-webhooks and hb://guides/portal-simulate to test events, hb://guides/portal-api-playground and hb://guides/portal-request-log-and-debugging to explore and debug, hb://guides/portal-go-to-production when ready. Use hb_search_guides to find other guides.',
          'If a step fails, find the guide with hb_search_guides (for example the FAQ: hb://guides/portal-faq-and-troubleshooting) and read the error message to the user.',
        ].join('\n'),
    },
    {
      name: 'go-live-checklist',
      title: 'Go-live checklist',
      description: 'Walk through moving an integration from a sandbox to the live Hub.',
      arguments: [],
      build: () =>
        [
          `Walk the user through going live. Current environment: ${env} (${ctx.config.baseUrl}).`,
          'Run hb_go_live_check first (pass the portals the integration needs): it reports environment, scopes, webhooks and the remaining steps. Read hb://guides/going-live and hb://guides/testing-and-sandbox. Then check, one item at a time, and report pass/fail:',
          '1. Everything worked in a sandbox: list the flows tested and the error cases (402, 403, 404, 409, 422, 429) handled.',
          '2. A new LIVE key exists with only the scopes the integration needs (least privilege), and an IP allowlist if appropriate. With the stdio transport the calls leave from the developer\'s own machine, so that machine\'s public IP is what the allowlist sees.',
          '3. Switch the server: HB_BASE_URL (or remove it for the default https://hub.hbcompliance.co.uk), HB_API_KEY = the live key, restart the client. Keep HB_READ_ONLY=true until the owner is ready; live writes also need HB_ALLOW_LIVE_WRITES=true and confirm=true per write.',
          '4. Run hb_status and confirm environment LIVE and the expected scopes. Check api_access too: Occupational Health and DBS & Right To Work (by default) need the Hub\'s one-off approval before live calls and webhook events work; a user of the organisation asks in the Hub under Developer > API access, and a refused area answers 403 api_access_*.',
          '5. Webhooks: register the endpoint again in live (new signing secret), verify signatures, dedupe on X-Hub-Event-Id.',
          '6. Identifiers: sandbox candidate_refs and ids mean nothing in live. Look up or create real candidates; never copy ids across.',
          '7. Rate limits and idempotency: 1,000 calls an hour per key by default; writes carry Idempotency-Key; no blind retries of writes.',
          'Do not run any live write as part of this checklist unless the user explicitly asks.',
        ].join('\n'),
    },
    {
      name: 'onboard-candidate',
      title: 'Add a new candidate',
      description: 'Check for duplicates, then create a candidate (plan first in live).',
      arguments: [
        { name: 'first_name', description: 'First name.', required: true },
        { name: 'last_name', description: 'Last name.', required: true },
        { name: 'email', description: 'Email address.', required: true },
      ],
      build: (a) =>
        [
          `Add candidate ${a.first_name} ${a.last_name} <${a.email}>. Environment: ${env}. ${writeLine}`,
          `1. ${call('hub.candidates.list')} with {"search": "${a.email}"} to check they do not exist (email must be unique per client).`,
          `2. Describe hub.candidates.create. Creating a candidate emails them an activation link unless is_active is false: say so to the user.`,
          `3. ${call('hub.candidates.create')} with body {first_name, last_name, email}. In live, show the plan and wait for the user's yes before confirm=true.`,
          '4. Report the candidate_ref; use that for everything after.',
        ].join('\n'),
    },
    {
      name: 'verify-a-certificate',
      title: 'Verify a training certificate',
      description: 'Check the price and balance, check the certificate file, submit it for verification, then follow the status and the webhook.',
      arguments: [
        { name: 'certificate_path', description: 'Absolute path of the certificate file (PDF, JPG or PNG) inside an allowed folder (HB_UPLOAD_DIRS).', required: true },
        { name: 'candidate_name', description: 'The candidate\'s name as on the certificate.', required: true },
        { name: 'agency', description: 'The agency or training provider named on the certificate (optional: ask if unknown).', required: false },
        { name: 'request_type', description: 'auto (default) or manual.', required: false },
      ],
      build: (a) =>
        [
          `Verify the training certificate ${a.certificate_path} for ${a.candidate_name}${a.agency ? `, agency on the certificate: ${a.agency}` : ''}${a.request_type ? `, request type: ${a.request_type}` : ''}. Environment: ${env}. ${writeLine}`,
          'The certificate is personal data: never print, paste or summarise the file contents or its base64, and do not copy it anywhere. Only its name, size, type and SHA-256 are shown.',
          '1. hb_status (or the status tool): confirm the environment and that the key has training-verification:write (it also reads). If the account has no Training Verification, every call is 403 portal_unavailable.',
          `2. Price and balance: the plan of hb_verify_certificate shows them (it reads ${call('training-verification.profile.show')}, ${call('training-verification.pricing.show')} and ${call('training-verification.credits.show')}). Automated (auto) is FREE for a regular account (one that also uses other Hub services) and charged for a verification-only account; Manual is charged for everyone; credits or the wallet pay, never a card. Tell the user the price before going on, and whether the balance covers it (a shortfall is 402 insufficient_credits: top up in the Hub).`,
          `3. File check and plan: call hb_verify_certificate with certificate_path, request_type (default auto), candidate_name, candidate_email, agency_name_on_cert and, if needed, notify_email, candidate_ref (from hb_find_candidate) and client_reference, WITHOUT confirm. It checks the file locally (it must be inside HB_UPLOAD_DIRS, not hidden, a .pdf, .jpg, .jpeg or .png within the size limit) and sends nothing. Ask the user for any missing detail; never invent an email address. Show the plan: file name, size, SHA-256, who gets the result email, price and balance.`,
          '4. After the user says yes, call the same tool again with the same arguments, the idempotency_key from the plan, file_sha256 from the plan and confirm=true. The answer is 202 with the verification id and status pending. Repeating with the same idempotency_key never charges twice.',
          '5. Follow it: hb_verification_status with verification_id shows the status (pending, processing, verified, not_found, rejected, failed), the result and the timeline. Automated usually finishes in minutes; Manual stays processing until staff decide. A pending verification can be cancelled with hb_change_booking (portal training-verification, booking_id = the verification id), which refunds a charge.',
          `6. Webhooks (optional): events training-verification.submitted, .processing, .verified, .not_found, .rejected, .failed and .refunded, each once per verification, carrying ids, status, reason code and the candidate name but never the certificate. In a sandbox hb_setup_sandbox_webhook subscribes them all when the key has a training-verification scope; verify deliveries with hb_verify_webhook_signature. ${call('training-verification.verifications.report')} (a PDF, once verified) and ${call('training-verification.verifications.certificate')} download files: use hb_get_report for how, and do not print them.`,
        ].join('\n'),
    },
  ];
}
