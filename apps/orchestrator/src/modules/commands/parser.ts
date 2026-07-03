/**
 * Command parser — T-M3-004, spec §12.3 + §14.3.
 *
 * Parses cgao bot-mention commands from GitHub issue comments. The
 * grammar is intentionally small:
 *
 *   @cgao <command> [args...]
 *
 * Commands are matched case-insensitively. Only `issue_comment.created`
 * events are parsed — `issue_comment.edited` events MUST NOT introduce
 * new commands (a stale /approve-plan from yesterday can't authorize
 * today's plan). Unknown commands return a structured ParseError so
 * the orchestrator can post a clarifying reply rather than silently
 * dropping the input.
 *
 * Contracts (spec §12.3):
 *
 *   - Only issue_comment.created is authoritative.
 *   - Edited comments never emit a fresh CommandEvent.
 *   - Unknown commands produce ParseError{kind:'unknown_command'}.
 *   - Argument-arity / shape mismatch produces ParseError{kind:'bad_args'}.
 */

import { z } from 'zod';

/**
 * The full command vocabulary. Each command maps to an action the
 * orchestrator is allowed to take. Strong commands (approve-plan,
 * cancel-run, merge-pr, etc.) additionally require authorization
 * (T-M3-005).
 */
export const commandNameSchema = z.enum([
  'help',
  'status',
  'plan',
  'approve-plan',
  'cancel-plan',
  'cancel-run',
  'retry',
  'merge-pr',
  'close',
  'reopen',
  'assign',
  'label',
  'unlabel',
  'answer',
  'abort',
]);
export type CommandName = z.infer<typeof commandNameSchema>;

/**
 * Strong commands — require explicit per-actor authorization (T-M3-005).
 * The authorizer records an entry in command_authorizations with the
 * source_comment_id, reason, and resolved permission.
 */
export const STRONG_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'approve-plan',
  'cancel-plan',
  'cancel-run',
  'merge-pr',
  'close',
  'abort',
]);

export interface ParsedCommand {
  /** Command name, lowercased. */
  name: CommandName;
  /** Whitespace-split args after the command name (raw, unparsed). */
  rawArgs: readonly string[];
  /** The line of the comment the command was found on (1-based). */
  line: number;
  /** The full matched command line (without trailing newline). */
  rawLine: string;
  /** True when the command name is in STRONG_COMMANDS. */
  requiresAuthorization: boolean;
}

export interface ParseSuccess {
  kind: 'success';
  commands: readonly ParsedCommand[];
}

export interface ParseError {
  kind: 'error';
  /** Line where the parse error originated (1-based, 0 if pre-scan). */
  line: number;
  /** Why the parse failed. */
  reason: ParseErrorReason;
  /** The offending raw text (truncated for safe logging). */
  rawExcerpt: string;
}

export type ParseErrorReason =
  | 'no_bot_mention'
  | 'unknown_command'
  | 'bad_args'
  | 'edited_event_rejected';

export type ParseResult = ParseSuccess | ParseError;

/**
 * Inputs to parseComment. The caller MUST populate `eventType`:
 * - 'issue_comment.created' → commands parsed.
 * - 'issue_comment.edited'  → ParseError{kind:'edited_event_rejected'}.
 */
export interface ParseCommentInput {
  /** The login cgao is mentioned as (case-insensitive prefix match). */
  botLogin: string;
  /** The comment body. */
  body: string;
  /** Author login (display only — never authoritative for permission). */
  authorLogin: string;
  /** GitHub event action. Only 'created' is parsed. */
  eventType: 'issue_comment.created' | 'issue_comment.edited' | string;
}

const COMMAND_ARG_RESOLVERS: Readonly<Record<CommandName, (args: readonly string[]) => boolean>> = {
  help: () => true,
  status: () => true,
  plan: () => true,
  'approve-plan': (a) => a.length === 1 && PLAN_AT_SHA_RE.test(a[0] ?? ''),
  'cancel-plan': (a) => a.length === 1 && PLAN_ID_RE.test(a[0] ?? ''),
  'cancel-run': (a) => a.length === 1 && a[0] !== '',
  retry: (a) => a.length <= 1,
  'merge-pr': (a) => a.length <= 1,
  close: () => true,
  reopen: () => true,
  assign: (a) => a.length >= 1,
  label: (a) => a.length >= 1,
  unlabel: (a) => a.length >= 1,
  answer: (a) => a.length >= 1,
  abort: (a) => a.length <= 1,
};

const PLAN_AT_SHA_RE = /^[a-z0-9_-]+@[0-9a-f]{8,64}$/u;
const PLAN_ID_RE = /^[a-z0-9_-]+$/u;

/**
 * Parse a comment for cgao bot-mention commands. Returns a ParseResult:
 * success (zero or more commands) or a single structured error.
 *
 * Multiple commands are allowed — one per line. Parse stops at the
 * first malformed line and returns that error.
 */
export function parseComment(input: ParseCommentInput): ParseResult {
  if (input.eventType !== 'issue_comment.created') {
    return {
      kind: 'error',
      line: 0,
      reason: 'edited_event_rejected',
      rawExcerpt: truncate(input.eventType),
    };
  }

  const mentionRe = buildMentionRegex(input.botLogin);
  const lines = input.body.split(/\r?\n/u);
  const commands: ParsedCommand[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const m = line.match(mentionRe);
    if (!m) continue;

    const rest = line.slice(m[0]?.length ?? 0).trim();
    if (!rest) continue;

    const tokens = rest.split(/\s+/u);
    const nameTok = (tokens[0] ?? '').toLowerCase();
    const args = tokens.slice(1);

    const parsed = commandNameSchema.safeParse(nameTok);
    if (!parsed.success) {
      return {
        kind: 'error',
        line: i + 1,
        reason: 'unknown_command',
        rawExcerpt: truncate(line),
      };
    }
    const name = parsed.data;
    const resolver = COMMAND_ARG_RESOLVERS[name];
    if (!resolver || !resolver(args)) {
      return {
        kind: 'error',
        line: i + 1,
        reason: 'bad_args',
        rawExcerpt: truncate(line),
      };
    }

    commands.push({
      name,
      rawArgs: args,
      line: i + 1,
      rawLine: line,
      requiresAuthorization: STRONG_COMMANDS.has(name),
    });
  }

  if (commands.length === 0) {
    return {
      kind: 'error',
      line: 0,
      reason: 'no_bot_mention',
      rawExcerpt: truncate(input.body),
    };
  }

  return { kind: 'success', commands };
}

/**
 * Build the bot-mention regex. Matches optional @ + the bot login,
 * case-insensitive, at the start of a line (after optional whitespace).
 */
function buildMentionRegex(botLogin: string): RegExp {
  const escaped = escapeRegex(botLogin);
  return new RegExp(`^\\s*@?${escaped}\\b\\s*`, 'ui');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function truncate(s: string, max = 120): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Command event schema — emitted by the orchestrator when a parsed
 * command survives authorization. Stored on the EventBus as
 * `cgao.command.received` with the payload below.
 */
export const commandEventSchema = z.object({
  type: z.literal('cgao.command.received'),
  source: z.literal('orchestrator'),
  subject: z.string(),
  traceId: z.string(),
  data: z.object({
    command: z.object({
      name: commandNameSchema,
      args: z.array(z.string()),
      line: z.number().int().positive(),
      rawLine: z.string(),
    }),
    issue: z.object({
      repo: z.string(),
      number: z.number().int().positive(),
    }),
    sourceCommentId: z.number().int().positive(),
    authorLogin: z.string(),
    requiresAuthorization: z.boolean(),
  }),
  headers: z.record(z.string()).default({}),
});
export type CommandEvent = z.infer<typeof commandEventSchema>;
