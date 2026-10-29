import type { AppContext } from '../context.js';
import { isTaskAvailable } from './task-support.js';
import { READ_TASKS } from './tasks-read.js';
import { WRITE_TASKS } from './tasks-write.js';
import type { ToolDefinition } from './types.js';

export const TASK_TOOL_NAMES = [
  'hb_find_candidate',
  'hb_candidate_overview',
  'hb_account_summary',
  'hb_needs_attention',
  'hb_go_live_check',
  'hb_book_practical_training',
  'hb_setup_sandbox_webhook',
] as const;

/** Every task tool, whether or not it is offered with this configuration (tests use this to reach hidden ones). */
export function allTaskTools(ctx: AppContext) {
  return [...READ_TASKS, ...WRITE_TASKS].map((make) => make(ctx));
}

/**
 * The curated task tools offered with this configuration, in compact and full mode alike. Tools that write are hidden while the
 * server is read-only; tools that need a toolset are hidden when HB_TOOLSETS leaves it out.
 */
export function buildTaskTools(ctx: AppContext): ToolDefinition[] {
  return allTaskTools(ctx)
    .filter((t) => isTaskAvailable(ctx, t.availability))
    .map((t) => t.definition);
}
