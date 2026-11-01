import { approvalNote } from '../approval.js';
import type { AppContext } from '../context.js';
import { isTaskAvailable } from './task-support.js';
import { READ_TASKS } from './tasks-read.js';
import { READ_TASKS_MORE } from './tasks-read-more.js';
import { WRITE_TASKS } from './tasks-write.js';
import { acknowledgeAlertsTool, bulkImportWorkersTool, verifyWorkerTool } from './tasks-monitoring.js';
import { assignTrainingTool, chaseOutstandingTool, requestOccupationalHealthTool, requestReferencesTool, saveCandidateTool } from './tasks-people.js';
import { bookSlotTool, changeBookingTool, inviteToPracticalTool } from './tasks-bookings.js';
import { redeliverWebhooksTool, rotateWebhookSecretTool } from './tasks-webhooks.js';
import { verificationStatusTool, verifyCertificateTool } from './tasks-verification.js';
import type { ToolDefinition } from './types.js';

/** The first seven task tools built, plus hb_credits, hb_list_bookings, hb_webhook_health and hb_verification_status: HB_TASK_TOOLS=core. */
export const CORE_TASK_TOOL_NAMES = [
  'hb_find_candidate',
  'hb_candidate_overview',
  'hb_account_summary',
  'hb_needs_attention',
  'hb_go_live_check',
  'hb_book_practical_training',
  'hb_setup_sandbox_webhook',
  'hb_credits',
  'hb_list_bookings',
  'hb_webhook_health',
  'hb_verification_status',
] as const;

/** Task tools that only read. */
export const READ_TASK_TOOL_NAMES = [
  'hb_find_candidate',
  'hb_candidate_overview',
  'hb_account_summary',
  'hb_needs_attention',
  'hb_go_live_check',
  'hb_training_progress',
  'hb_list_bookings',
  'hb_credits',
  'hb_webhook_health',
  'hb_monitoring_alerts',
  'hb_worker_status',
  'hb_billing_summary',
  'hb_get_report',
  'hb_verification_status',
] as const;

/** Task tools that write (two-call plan then confirm; hidden while read-only). */
export const WRITE_TASK_TOOL_NAMES = [
  'hb_book_practical_training',
  'hb_setup_sandbox_webhook',
  'hb_book_slot',
  'hb_change_booking',
  'hb_invite_to_practical',
  'hb_save_candidate',
  'hb_assign_training',
  'hb_request_references',
  'hb_request_occupational_health',
  'hb_chase_outstanding',
  'hb_verify_worker',
  'hb_acknowledge_alerts',
  'hb_bulk_import_workers',
  'hb_redeliver_webhooks',
  'hb_rotate_webhook_secret',
  'hb_verify_certificate',
] as const;

export const TASK_TOOL_NAMES = [...READ_TASK_TOOL_NAMES, ...WRITE_TASK_TOOL_NAMES] as const;

const MORE_WRITE_TASKS = [
  bookSlotTool, changeBookingTool, inviteToPracticalTool, saveCandidateTool, assignTrainingTool, requestReferencesTool, requestOccupationalHealthTool,
  chaseOutstandingTool, verifyWorkerTool, acknowledgeAlertsTool, bulkImportWorkersTool, redeliverWebhooksTool, rotateWebhookSecretTool, verifyCertificateTool,
];

/** Task tools that call an area that needs the Hub's manual approval for live use, and which areas (toolsets). */
const APPROVAL_AREAS: Record<string, string[]> = {
  hb_request_occupational_health: ['occupational-health'],
  hb_candidate_overview: ['occupational-health'],
  hb_account_summary: ['occupational-health', 'dbs-rtw'],
  hb_needs_attention: ['occupational-health', 'dbs-rtw'],
  hb_go_live_check: ['occupational-health', 'dbs-rtw'],
  hb_chase_outstanding: ['occupational-health'],
  hb_credits: ['occupational-health'],
  hb_get_report: ['occupational-health'],
  hb_monitoring_alerts: ['occupational-health', 'dbs-rtw'],
  hb_acknowledge_alerts: ['occupational-health', 'dbs-rtw'],
  hb_verify_worker: ['dbs-rtw'],
  hb_worker_status: ['dbs-rtw'],
  hb_billing_summary: ['dbs-rtw'],
  hb_bulk_import_workers: ['dbs-rtw'],
};

/** Every task tool, whether or not it is offered with this configuration (tests use this to reach hidden ones). */
export function allTaskTools(ctx: AppContext) {
  return [...READ_TASKS, ...READ_TASKS_MORE, verificationStatusTool, ...WRITE_TASKS, ...MORE_WRITE_TASKS].map((make) => {
    const task = make(ctx);
    const note = approvalNote(APPROVAL_AREAS[task.definition.name] ?? []);
    return note ? { ...task, definition: { ...task.definition, description: `${task.definition.description} ${note}` } } : task;
  });
}

/**
 * The curated task tools offered with this configuration, in compact and full mode alike. HB_TASK_TOOLS picks all, the core set or none;
 * tools that write are hidden while the server is read-only; tools that need a toolset are hidden when HB_TOOLSETS leaves it out.
 */
export function buildTaskTools(ctx: AppContext): ToolDefinition[] {
  const mode = ctx.config.taskTools;
  if (mode === 'none') return [];
  return allTaskTools(ctx)
    .filter((t) => mode === 'all' || (CORE_TASK_TOOL_NAMES as readonly string[]).includes(t.definition.name))
    .filter((t) => isTaskAvailable(ctx, t.availability))
    .map((t) => t.definition);
}
