/**
 * T-M9-006 MergeQueueAdapter + MergeGroupHandler.
 *
 * Contracts (spec §12.10 / §17):
 *   - Required checks declared runnable on the merge_group ref.
 *   - After queue passes, the run is archived (status=merged).
 *   - Reuses the final evaluator with current_head_sha = merge_group head.
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import { describe, expect, it } from 'vitest';
import { GateAggregator } from '../gate-aggregator.js';
import { GateResultsReader } from '../gate-results-reader.js';
import { GitHubStateHydrator } from '../github-state-hydrator.js';
import {
  DEFAULT_QUEUE_DECLARATIONS,
  MergeGroupHandler,
  MergeQueueAdapter,
  type MergeQueueEvent,
  type MergeQueuePort,
  type RequiredCheckDeclaration,
} from '../index.js';
import type { BranchProtectionSnapshot, LivePrSnapshot, TrustedGitHubPrPort } from '../index.js';
import { MergeFinalEvaluator } from '../merge-final-evaluator.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

class StubQueue implements MergeQueuePort {
  declarations = new Map<string, RequiredCheckDeclaration>();
  archived: { runId: string; mergeCommitSha: string }[] = [];
  async listRequiredChecks(args: { repo: string }) {
    void args;
    return [...this.declarations.values()].filter((d) =>
      DEFAULT_QUEUE_DECLARATIONS.some((x: RequiredCheckDeclaration) => x.job === d.job),
    );
  }
  async upsertRequiredCheck(args: {
    repo: string;
    job: string;
    contexts: ReadonlyArray<'pull_request' | 'merge_group'>;
  }) {
    this.declarations.set(args.job, { job: args.job, contexts: args.contexts });
  }
  async archiveRun(args: { runId: string; mergeCommitSha: string }) {
    this.archived.push(args);
  }
}

class StubGithub implements TrustedGitHubPrPort {
  private pr: LivePrSnapshot | null = null;
  setPr(pr: LivePrSnapshot | null) {
    this.pr = pr;
    return this;
  }
  async fetchPr() {
    return this.pr;
  }
  async fetchBranchProtection(): Promise<BranchProtectionSnapshot | null> {
    return null;
  }
}

function makeLive(): LivePrSnapshot {
  return {
    prNumber: 1,
    headSha: HEAD,
    baseSha: BASE,
    baseBranch: 'main',
    mergeableState: 'clean',
    state: 'open',
    protected: false,
  };
}

describe('T-M9-006 MergeQueueAdapter', () => {
  it('ensures required checks are declared on merge_group', async () => {
    const stub = new StubQueue();
    const adapter = new MergeQueueAdapter(stub);
    await adapter.ensureChecksDeclared({ repo: 'cgao/test' });
    for (const decl of DEFAULT_QUEUE_DECLARATIONS) {
      const got = stub.declarations.get(decl.job);
      expect(got).toBeDefined();
      expect(got?.contexts).toContain('merge_group');
    }
  });

  it('archives the run after queue pass', async () => {
    const stub = new StubQueue();
    const adapter = new MergeQueueAdapter(stub);
    const out = await adapter.archiveRun({ runId: 'run_1', mergeCommitSha: 'e'.repeat(40) });
    expect(out.status).toBe('merged');
    expect(stub.archived.length).toBe(1);
  });
});

describe('T-M9-006 MergeGroupHandler', () => {
  function makeEvaluator(stub: TrustedGitHubPrPort) {
    const reader = new GateResultsReader({
      testGates: {
        async findLatest() {
          return {
            runId: 'run_1',
            headSha: HEAD,
            baseSha: BASE,
            passed: true,
            logArtifactRef: 'sha256:test',
          };
        },
      } as never,
      aiReviews: {
        async list() {
          return [
            {
              runId: 'run_1',
              headSha: HEAD,
              reviewer: 'code' as const,
              completed: true,
              reviewArtifactRef: 'sha256:code',
            },
            {
              runId: 'run_1',
              headSha: HEAD,
              reviewer: 'security' as const,
              completed: true,
              reviewArtifactRef: 'sha256:sec',
            },
          ];
        },
      } as never,
      humanApprovals: {
        async findLatest() {
          return { actor: 'alice', headSha: HEAD, approvedAt: '2026-01-01T00:00:00.000Z' };
        },
      } as never,
      risk: {
        async find() {
          return {
            runId: 'run_1',
            headSha: HEAD,
            severity: 'low' as const,
            requiresHumanReview: false,
          };
        },
      } as never,
      findings: {
        async findBlocking() {
          return [];
        },
      } as never,
    });
    const aggregator = new GateAggregator(reader);
    const hydrator = new GitHubStateHydrator(stub);
    const store = new InMemoryArtifactStore();
    return new MergeFinalEvaluator({ hydrator, aggregator, store });
  }

  it('re-runs the final evaluator against the merge_group head sha', async () => {
    const queueStub = new StubQueue();
    const adapter = new MergeQueueAdapter(queueStub);
    const ghStub = new StubGithub().setPr(makeLive());
    const evaluator = makeEvaluator(ghStub);
    const handler = new MergeGroupHandler({
      queue: adapter,
      evaluator,
      runState: {
        async getTestedShas() {
          return { testedHeadSha: HEAD, testedBaseSha: BASE };
        },
      },
      risk: {
        async isHighRisk() {
          return false;
        },
      },
    });
    const event: MergeQueueEvent = {
      repo: 'cgao/test',
      runId: 'run_1',
      prNumber: 1,
      mergeGroupHeadSha: HEAD,
      mergeGroupBaseSha: BASE,
    };
    const out = await handler.onMergeGroup(event);
    expect(out.decision).toBe('merge');
    expect(out.archived).toBe(true);
    expect(queueStub.archived.length).toBe(1);
  });

  it('refuses to archive when the final evaluator refuses', async () => {
    const queueStub = new StubQueue();
    const adapter = new MergeQueueAdapter(queueStub);
    const ghStub = new StubGithub().setPr({ ...makeLive(), mergeableState: 'dirty' });
    const evaluator = makeEvaluator(ghStub);
    const handler = new MergeGroupHandler({
      queue: adapter,
      evaluator,
      runState: {
        async getTestedShas() {
          return { testedHeadSha: HEAD, testedBaseSha: BASE };
        },
      },
      risk: {
        async isHighRisk() {
          return false;
        },
      },
    });
    const out = await handler.onMergeGroup({
      repo: 'cgao/test',
      runId: 'run_1',
      prNumber: 1,
      mergeGroupHeadSha: HEAD,
      mergeGroupBaseSha: BASE,
    });
    expect(out.decision).not.toBe('merge');
    expect(out.archived).toBe(false);
    expect(queueStub.archived.length).toBe(0);
  });
});
