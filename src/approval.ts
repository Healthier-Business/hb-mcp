/**
 * Manual approval of sensitive areas (live only). By default Occupational Health and DBS & Right To Work need Hub staff to approve the
 * client before their API calls work and before their webhook events are sent. Hub staff choose the list, so the live list comes from
 * GET /account/api-access; the constants here are only the wording of static descriptions. The sandbox is always open.
 */

export const API_ACCESS_CODES = ['api_access_not_approved', 'api_access_pending', 'api_access_rejected', 'api_access_revoked'] as const;
export type ApiAccessCode = (typeof API_ACCESS_CODES)[number];

/** The areas that need approval by default, as toolsets (the same words as the portal keys). */
export const DEFAULT_SENSITIVE_TOOLSETS: readonly string[] = ['occupational-health', 'dbs-rtw'];

/** Where a person asks for approval. */
export const APPROVAL_PLACE = 'in the Hub under Developer > API access';

const STATUS_BY_CODE: Record<ApiAccessCode, string> = {
  api_access_not_approved: 'not requested',
  api_access_pending: 'pending',
  api_access_rejected: 'rejected',
  api_access_revoked: 'revoked',
};

const LABELS: Record<string, string> = {
  hub: 'Hub',
  account: 'Account',
  'online-training': 'Online Training',
  'occupational-health': 'Occupational Health',
  references: 'References',
  'practical-training': 'Practical Training',
  'virtual-bls-training': 'Virtual BLS Training',
  'clinical-interviews': 'Clinical Interviews',
  'registration-monitoring': 'Registration Monitoring',
  'dbs-rtw': 'DBS & Right To Work',
  'clinical-appraisals': 'Clinical Appraisals',
  'training-verification': 'Training Verification',
};

export function isApprovalCode(code: string): boolean {
  return (API_ACCESS_CODES as readonly string[]).includes(code) || code === 'webhook_events_not_approved';
}

/** A portal key as a name for people: `occupational-health` becomes Occupational Health. */
export function areaLabel(area: string): string {
  return LABELS[area] ?? area.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanList(v: unknown): string[] | undefined {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 100).slice(0, 50) : [];
  return list.length ? list : undefined;
}

/** Pick the approval fields out of a Hub error body, ignoring anything unexpected. */
export function approvalDetailsFrom(body: Record<string, unknown>): { areas?: string[]; events?: string[]; docsUrl?: string } {
  const docs = typeof body.docs_url === 'string' && /^https:\/\/[^\s]+$/.test(body.docs_url) ? body.docs_url : undefined;
  return { areas: cleanList(body.areas), events: cleanList(body.events), docsUrl: docs };
}

/** The plain-language line for an approval refusal, for the AI assistant to relay. */
export function approvalGuidance(code: string, d: { areas?: string[]; events?: string[]; docsUrl?: string }): string {
  const names = (d.areas ?? []).map(areaLabel);
  const what = names.length ? names.join(' and ') : 'This area';
  const docs = d.docsUrl ? ` Docs: ${d.docsUrl}` : '';
  if (code === 'webhook_events_not_approved') {
    const events = d.events?.length ? ` Refused events: ${d.events.join(', ')}.` : '';
    return `${what} ${names.length > 1 ? 'need' : 'needs'} approval ${APPROVAL_PLACE} before a webhook endpoint can subscribe to its events.${events}${docs}`;
  }
  const status = STATUS_BY_CODE[code as ApiAccessCode] ?? 'not approved';
  return `${what} ${names.length > 1 ? 'need' : 'needs'} approval ${APPROVAL_PLACE}; status: ${status}.${docs}`;
}

/** A sentence for the description of a tool or operation of a sensitive area, or '' for any other toolset. */
export function approvalNote(toolsets: Iterable<string>): string {
  const hit = [...new Set(toolsets)].filter((t) => DEFAULT_SENSITIVE_TOOLSETS.includes(t));
  if (!hit.length) return '';
  const names = hit.map(areaLabel).join(' and ');
  return `Live use of ${names} needs the Hub's one-off approval (${APPROVAL_PLACE}; by default these areas; account.api-access.show or hb_status shows the state per area); until then live calls answer 403 api_access_*. The sandbox is always open.`;
}
