/**
 * Strong-command authorization — T-M3-005, spec §12.3 + §14.3 + §15.
 *
 * Strong commands (T-M3-004 STRONG_COMMANDS) require per-actor
 * authorization before the orchestrator executes them. This module:
 *
 *   1. Resolves the actor's GitHub permission on the repo (admin /
 *      maintain / write / read / none) via a swappable resolver.
 *   2. Applies the policy table: which command requires which level.
 *   3. Writes an authorization record to command_authorizations AND
 *      appends an audit record (the audit hash-chain is appended via
 *      the AuditLog port — never bypassed).
 *
 * Contracts (spec §12.3, §15):
 *
 *   - Non-authorized /approve-plan is REJECTED (decision.kind='deny').
 *   - Authorization record carries actor, permission, source_comment_id,
 *     reason — and is auditable.
 *   - Denials are audited too (defense in depth).
 */

import type { CommandName } from './parser.js';

/** GitHub collaborative permission level, in descending order. */
export type GitHubPermission = 'admin' | 'maintain' | 'write' | 'read' | 'none';

/**
 * Lookup the actor's effective permission on a repo. Implementations
 * MUST call the GitHub API (collaborator permission endpoint) and MUST
 * NOT trust the webhook's "member.permission" field verbatim.
 */
export interface GitHubPermissionResolver {
  resolve(args: { repo: string; actorLogin: string }): Promise<GitHubPermission>;
}

/**
 * Per-command minimum required permission. Spec §15 maps the strong
 * commands to required permission levels.
 */
export const COMMAND_PERMISSION_POLICY: Readonly<Record<CommandName, GitHubPermission>> =
  Object.freeze({
    help: 'read',
    status: 'read',
    plan: 'read',
    'approve-plan': 'maintain',
    'cancel-plan': 'write',
    'cancel-run': 'write',
    retry: 'write',
    'merge-pr': 'admin',
    close: 'write',
    reopen: 'write',
    assign: 'write',
    label: 'write',
    unlabel: 'write',
    answer: 'read',
    abort: 'admin',
  });

export type AuthorizationDecision =
  | {
      kind: 'allow';
      actor: string;
      permission: GitHubPermission;
      command: CommandName;
      sourceCommentId: number;
      reason: string;
    }
  | {
      kind: 'deny';
      actor: string;
      permission: GitHubPermission;
      command: CommandName;
      sourceCommentId: number;
      reason: string;
    };

/**
 * Persistent record written to command_authorizations. The audit log
 * entry is a SEPARATE write (append-only hash chain) — see audit()
 * return on the service.
 */
export interface CommandAuthorizationRecord {
  /** Stable id for the record (uuid or repo+commentId+commandline hash). */
  id: string;
  repo: string;
  issueNumber: number;
  command: CommandName;
  actor: string;
  resolvedPermission: GitHubPermission;
  requiredPermission: GitHubPermission;
  decision: 'allow' | 'deny';
  reason: string;
  sourceCommentId: number;
  createdAt: string;
}

export interface CommandAuthorizationRepository {
  insert(args: CommandAuthorizationRecord): Promise<void>;
  /** Look up the most recent authorization for a (repo, comment, command). */
  findLatestForComment(args: {
    repo: string;
    sourceCommentId: number;
    command: CommandName;
  }): Promise<CommandAuthorizationRecord | null>;
}

/**
 * Minimal audit-log port. The orchestrator's real AuditLog appends to
 * an append-only hash chain; here we just expose the append method.
 */
export interface AuditLog {
  append(args: {
    action: string;
    actor: string;
    target: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface AuthorizeInput {
  repo: string;
  issueNumber: number;
  command: CommandName;
  actor: string;
  sourceCommentId: number;
  /** Override the policy-required permission (rare; for tests/overrides). */
  requiredPermissionOverride?: GitHubPermission;
  now?: Date;
}

export class CommandAuthorizationService {
  constructor(
    private readonly resolver: GitHubPermissionResolver,
    private readonly repo: CommandAuthorizationRepository,
    private readonly audit: AuditLog,
    private readonly idFactory: () => string = () => crypto.randomUUID(),
  ) {}

  async authorize(input: AuthorizeInput): Promise<AuthorizationDecision> {
    const permission = await this.resolver.resolve({
      repo: input.repo,
      actorLogin: input.actor,
    });
    const required =
      input.requiredPermissionOverride ?? COMMAND_PERMISSION_POLICY[input.command] ?? 'admin';
    const ok = permissionRank(permission) >= permissionRank(required);
    const reason = ok
      ? `actor '${input.actor}' has '${permission}' ≥ required '${required}'`
      : `actor '${input.actor}' has '${permission}' < required '${required}'`;

    const decision: AuthorizationDecision = ok
      ? {
          kind: 'allow',
          actor: input.actor,
          permission,
          command: input.command,
          sourceCommentId: input.sourceCommentId,
          reason,
        }
      : {
          kind: 'deny',
          actor: input.actor,
          permission,
          command: input.command,
          sourceCommentId: input.sourceCommentId,
          reason,
        };

    const now = input.now ?? new Date();
    const record: CommandAuthorizationRecord = {
      id: this.idFactory(),
      repo: input.repo,
      issueNumber: input.issueNumber,
      command: input.command,
      actor: input.actor,
      resolvedPermission: permission,
      requiredPermission: required,
      decision: decision.kind,
      reason,
      sourceCommentId: input.sourceCommentId,
      createdAt: now.toISOString(),
    };
    await this.repo.insert(record);

    // Defense in depth: denials are audited too.
    await this.audit.append({
      action: `command.authorize.${decision.kind}`,
      actor: input.actor,
      target: `${input.repo}#${input.issueNumber}`,
      payload: {
        command: input.command,
        sourceCommentId: input.sourceCommentId,
        resolvedPermission: permission,
        requiredPermission: required,
        reason,
      },
    });

    return decision;
  }
}

const RANK: Record<GitHubPermission, number> = {
  admin: 4,
  maintain: 3,
  write: 2,
  read: 1,
  none: 0,
};

export function permissionRank(p: GitHubPermission): number {
  return RANK[p];
}
