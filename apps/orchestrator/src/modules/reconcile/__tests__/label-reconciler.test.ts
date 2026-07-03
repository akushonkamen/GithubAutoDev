/**
 * T-M10-002 LabelReconciler.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import { describe, expect, it } from 'vitest';
import { type LabelMutationPort, LabelReconciler } from '../label-reconciler.js';

class StubLabels implements LabelMutationPort {
  added: string[] = [];
  removed: string[] = [];
  async addLabel(args: { label: string }) {
    this.added.push(args.label);
  }
  async removeLabel(args: { label: string }) {
    this.removed.push(args.label);
  }
}

describe('T-M10-002 LabelReconciler', () => {
  it('adds missing cgao: labels and removes spurious cgao: labels', async () => {
    const audit = new InMemoryAuditChainService();
    const labels = new StubLabels();
    const r = new LabelReconciler(labels, audit);
    const out = await r.reconcile({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 1,
      expectedLabels: ['cgao:plan-ready'],
      liveLabels: ['cgao:merged', 'bug'],
    });
    expect(out.added).toEqual(['cgao:plan-ready']);
    expect(out.removed).toEqual(['cgao:merged']);
    expect(out.reason).toBe('repaired');
  });

  it('records audit chain entries for each mutation', async () => {
    const audit = new InMemoryAuditChainService();
    const labels = new StubLabels();
    const r = new LabelReconciler(labels, audit);
    await r.reconcile({
      runId: 'run_2',
      repo: 'cgao/test',
      issueNumber: 2,
      expectedLabels: [],
      liveLabels: ['cgao:plan-ready'],
    });
    const chain = await audit.listByRun('run_2');
    expect(chain.some((rec) => rec.kind === 'label.unset')).toBe(true);
  });

  it('is a no-op when projection matches reality', async () => {
    const audit = new InMemoryAuditChainService();
    const labels = new StubLabels();
    const r = new LabelReconciler(labels, audit);
    const out = await r.reconcile({
      runId: 'run_3',
      repo: 'cgao/test',
      issueNumber: 3,
      expectedLabels: ['cgao:plan-ready'],
      liveLabels: ['cgao:plan-ready'],
    });
    expect(out.added).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.reason).toBe('in-sync');
    expect(labels.added.length).toBe(0);
    expect(labels.removed.length).toBe(0);
  });
});
