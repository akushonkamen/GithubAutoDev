/**
 * Strong-command authorization — T-M3-005, spec §12.3 + §15.
 *
 * Locks the contracts:
 *   - Non-authorized actor's /approve-plan is DENIED.
 *   - Decision carries actor, permission, source_comment_id, reason.
 *   - Every decision (allow AND deny) writes a record AND appends audit.
 *   - Policy table: approve-plan=maintain, merge-pr/abort=admin, etc.
 */

import { describe, expect, it } from 'vitest';
import {
  type AuditLog,
  COMMAND_PERMISSION_POLICY,
  type CommandAuthorizationRecord,
  type CommandAuthorizationRepository,
  CommandAuthorizationService,
  type GitHubPermission,
  type GitHubPermissionResolver,
} from '../authorization.js';

class FakeResolver implements GitHubPermissionResolver {
  constructor(private readonly perm: GitHubPermission) {}
  resolve(): Promise<GitHubPermission> {
    return Promise.resolve(this.perm);
  }
}

class InMemoryRepo implements CommandAuthorizationRepository {
  public readonly records: CommandAuthorizationRecord[] = [];
  insert(args: CommandAuthorizationRecord): Promise<void> {
    this.records.push(args);
    return Promise.resolve();
  }
  findLatestForComment(args: {
    repo: string;
    sourceCommentId: number;
    command: string;
  }): Promise<CommandAuthorizationRecord | null> {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const r = this.records[i];
      if (
        r &&
        r.repo === args.repo &&
        r.sourceCommentId === args.sourceCommentId &&
        r.command === args.command
      ) {
        return Promise.resolve(r);
      }
    }
    return Promise.resolve(null);
  }
}

class CapturingAuditLog implements AuditLog {
  public readonly entries: Array<{
    action: string;
    actor: string;
    target: string;
    payload: Record<string, unknown>;
  }> = [];
  append(args: {
    action: string;
    actor: string;
    target: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.entries.push(args);
    return Promise.resolve();
  }
}

describe('COMMAND_PERMISSION_POLICY (T-M3-005)', () => {
  it('requires maintain for approve-plan', () => {
    expect(COMMAND_PERMISSION_POLICY['approve-plan']).toBe('maintain');
  });

  it('requires admin for merge-pr and abort', () => {
    expect(COMMAND_PERMISSION_POLICY['merge-pr']).toBe('admin');
    expect(COMMAND_PERMISSION_POLICY.abort).toBe('admin');
  });

  it('read commands (help, status, plan, answer) require read', () => {
    expect(COMMAND_PERMISSION_POLICY.help).toBe('read');
    expect(COMMAND_PERMISSION_POLICY.status).toBe('read');
    expect(COMMAND_PERMISSION_POLICY.answer).toBe('read');
  });
});

describe('CommandAuthorizationService (T-M3-005)', () => {
  it('denies /approve-plan when actor lacks maintain', async () => {
    const repo = new InMemoryRepo();
    const audit = new CapturingAuditLog();
    const svc = new CommandAuthorizationService(
      new FakeResolver('write'),
      repo,
      audit,
      () => 'auth-1',
    );
    const d = await svc.authorize({
      repo: 'cgao/test',
      issueNumber: 1,
      command: 'approve-plan',
      actor: 'alice',
      sourceCommentId: 42,
    });
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.actor).toBe('alice');
    expect(d.permission).toBe('write');
    expect(d.sourceCommentId).toBe(42);
    expect(d.reason).toContain('write');
    expect(d.reason).toContain('maintain');
  });

  it('allows /approve-plan when actor has maintain', async () => {
    const repo = new InMemoryRepo();
    const audit = new CapturingAuditLog();
    const svc = new CommandAuthorizationService(new FakeResolver('admin'), repo, audit);
    const d = await svc.authorize({
      repo: 'cgao/test',
      issueNumber: 1,
      command: 'approve-plan',
      actor: 'ceo',
      sourceCommentId: 1,
    });
    expect(d.kind).toBe('allow');
  });

  it('writes an authorization record with actor, permission, comment, reason', async () => {
    const repo = new InMemoryRepo();
    const audit = new CapturingAuditLog();
    const svc = new CommandAuthorizationService(
      new FakeResolver('maintain'),
      repo,
      audit,
      () => 'rec-1',
    );
    await svc.authorize({
      repo: 'cgao/test',
      issueNumber: 1,
      command: 'approve-plan',
      actor: 'alice',
      sourceCommentId: 7,
      now: new Date('2026-07-03T00:00:00Z'),
    });
    expect(repo.records).toHaveLength(1);
    const r = repo.records[0];
    expect(r).toMatchObject({
      id: 'rec-1',
      repo: 'cgao/test',
      issueNumber: 1,
      command: 'approve-plan',
      actor: 'alice',
      resolvedPermission: 'maintain',
      requiredPermission: 'maintain',
      decision: 'allow',
      sourceCommentId: 7,
      reason: expect.stringContaining('maintain'),
    });
  });

  it('appends to audit log on allow', async () => {
    const repo = new InMemoryRepo();
    const audit = new CapturingAuditLog();
    const svc = new CommandAuthorizationService(new FakeResolver('admin'), repo, audit);
    await svc.authorize({
      repo: 'cgao/test',
      issueNumber: 1,
      command: 'merge-pr',
      actor: 'ceo',
      sourceCommentId: 9,
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.action).toBe('command.authorize.allow');
    expect(audit.entries[0]?.actor).toBe('ceo');
  });

  it('appends to audit log on deny (defense in depth)', async () => {
    const repo = new InMemoryRepo();
    const audit = new CapturingAuditLog();
    const svc = new CommandAuthorizationService(new FakeResolver('read'), repo, audit);
    await svc.authorize({
      repo: 'cgao/test',
      issueNumber: 1,
      command: 'merge-pr',
      actor: 'newbie',
      sourceCommentId: 10,
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.action).toBe('command.authorize.deny');
  });

  it('merge-pr requires admin (write is not enough)', async () => {
    const repo = new InMemoryRepo();
    const audit = new CapturingAuditLog();
    const svc = new CommandAuthorizationService(new FakeResolver('write'), repo, audit);
    const d = await svc.authorize({
      repo: 'cgao/test',
      issueNumber: 1,
      command: 'merge-pr',
      actor: 'alice',
      sourceCommentId: 11,
    });
    expect(d.kind).toBe('deny');
  });

  it('none permission denies everything', async () => {
    const repo = new InMemoryRepo();
    const audit = new CapturingAuditLog();
    const svc = new CommandAuthorizationService(new FakeResolver('none'), repo, audit);
    for (const command of ['help', 'status', 'approve-plan', 'merge-pr'] as const) {
      const d = await svc.authorize({
        repo: 'cgao/test',
        issueNumber: 1,
        command,
        actor: 'unknown',
        sourceCommentId: 12,
      });
      expect(d.kind, command).toBe('deny');
    }
  });

  it('allows override of required permission', async () => {
    const repo = new InMemoryRepo();
    const audit = new CapturingAuditLog();
    const svc = new CommandAuthorizationService(new FakeResolver('read'), repo, audit);
    const d = await svc.authorize({
      repo: 'cgao/test',
      issueNumber: 1,
      command: 'merge-pr',
      actor: 'alice',
      sourceCommentId: 13,
      requiredPermissionOverride: 'read',
    });
    expect(d.kind).toBe('allow');
  });
});
