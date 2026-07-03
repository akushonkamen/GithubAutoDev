/**
 * Issue triage rule engine — T-M3-001, spec §12.3.
 *
 * Locks the contracts:
 *   - All six categories (bug/feature/docs/question/security/chore) are
 *     reachable via keyword + advisory hint.
 *   - Insufficient information → status=needs_info + missing fields.
 *   - Closed issues NEVER enter the dev flow.
 *   - StatusProjectionService diff computes minimal add/remove label sets.
 */

import { describe, expect, it } from 'vitest';
import {
  InformationCompletenessRules,
  IssueClassifier,
  type IssueSnapshot,
  IssueTriageService,
  StatusProjectionService,
  keywordCategory,
} from '../triage.js';

function snapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 1,
    title: 'deploy broken',
    body: '',
    closed: false,
    existingLabels: [],
    authorLogin: 'alice',
    ...overrides,
  };
}

describe('IssueClassifier (T-M3-001)', () => {
  const clf = new IssueClassifier();

  it('classifies a security report via keyword', () => {
    expect(
      clf.classify(snapshot({ title: 'CVE in auth module', body: 'security vulnerability' })),
    ).toBe('security');
  });

  it('classifies a bug via keyword', () => {
    expect(clf.classify(snapshot({ title: 'crash on startup', body: 'the app crashes' }))).toBe(
      'bug',
    );
  });

  it('classifies a feature request via keyword', () => {
    expect(
      clf.classify(snapshot({ title: 'Feature: dark mode', body: 'would be nice to add' })),
    ).toBe('feature');
  });

  it('classifies a docs change via keyword', () => {
    expect(clf.classify(snapshot({ title: 'typo in README', body: 'fix docs spelling' }))).toBe(
      'docs',
    );
  });

  it('classifies a question via keyword', () => {
    expect(
      clf.classify(snapshot({ title: 'How do I configure X?', body: 'help me understand' })),
    ).toBe('question');
  });

  it('classifies a chore via keyword', () => {
    expect(
      clf.classify(snapshot({ title: 'chore: bump deps', body: 'upgrade dependency versions' })),
    ).toBe('chore');
  });

  it('returns unknown when nothing matches', () => {
    expect(clf.classify(snapshot({ title: 'xyzzy', body: 'qwerty' }))).toBe('unknown');
  });

  it('uses an advisory hint when confidence is high enough', () => {
    const cat = clf.classify(snapshot({ title: 'weird title', body: 'nothing useful' }), {
      categoryHint: 'bug',
      confidence: 0.9,
    });
    expect(cat).toBe('bug');
  });

  it('ignores a low-confidence hint and falls back to keywords', () => {
    const cat = clf.classify(snapshot({ title: 'crash', body: 'bug' }), {
      categoryHint: 'feature',
      confidence: 0.3,
    });
    expect(cat).toBe('bug');
  });

  it('returns unknown for closed issues regardless of body', () => {
    expect(clf.classify(snapshot({ title: 'crash', body: 'bug crash broken', closed: true }))).toBe(
      'unknown',
    );
  });
});

describe('keywordCategory (T-M3-001)', () => {
  it('matches case-insensitively', () => {
    expect(keywordCategory('BUG REPORT', '')).toBe('bug');
  });

  it('uses word boundaries (not substring)', () => {
    expect(keywordCategory('hugbug feature', '')).toBe('feature');
  });
});

describe('InformationCompletenessRules (T-M3-001)', () => {
  const rules = new InformationCompletenessRules();

  it('bug missing repro+expected+actual → needs_info', () => {
    const m = rules.evaluate('bug', snapshot({ body: 'something broke' }), {});
    expect(m).toContain('steps_to_reproduce');
    expect(m).toContain('expected_behavior');
    expect(m).toContain('actual_behavior');
  });

  it('bug with full sections → ready', () => {
    const body = [
      '## Steps to reproduce',
      'run deploy',
      '## Expected',
      'green deploy',
      '## Actual',
      'red deploy',
    ].join('\n');
    expect(rules.evaluate('bug', snapshot({ body }), {})).toEqual([]);
  });

  it('feature missing user story + acceptance', () => {
    const m = rules.evaluate('feature', snapshot({ body: 'I want a button' }), {});
    expect(m).toContain('user_story');
    expect(m).toContain('acceptance_criteria');
  });

  it('security is ALWAYS needs_info (human_ack_required)', () => {
    const body = '## Affected component\n auth\n## Severity\n high';
    const m = rules.evaluate('security', snapshot({ body }), { severityHint: 'high' });
    expect(m).toContain('human_ack_required');
  });

  it('docs missing location', () => {
    expect(rules.evaluate('docs', snapshot({ body: 'fix typo' }), {})).toContain('location');
  });

  it('chore missing scope', () => {
    expect(rules.evaluate('chore', snapshot({ body: 'bump version' }), {})).toContain('scope');
  });

  it('question never needs_info', () => {
    expect(rules.evaluate('question', snapshot({ body: '?' }), {})).toEqual([]);
  });

  it('unknown with empty body needs description', () => {
    expect(rules.evaluate('unknown', snapshot({ body: '' }), {})).toContain('description');
  });
});

describe('StatusProjectionService (T-M3-001)', () => {
  const proj = new StatusProjectionService();

  it('formats status and kind labels with the cgao: prefix', () => {
    expect(proj.statusLabel('needs_info')).toBe('cgao:status/needs_info');
    expect(proj.kindLabel('bug')).toBe('cgao:kind/bug');
  });

  it('diffs labels case-insensitively', () => {
    const diff = proj.diffLabels(['cgao:KIND/Bug', 'cgao:status/ready', 'priority:high'], {
      category: 'bug',
      status: 'needs_info',
    });
    expect(diff.add).toContain('cgao:status/needs_info');
    expect(diff.remove).toContain('cgao:status/ready');
    // Existing non-cgao labels are left alone.
    expect(diff.remove).not.toContain('priority:high');
    // kind stays at bug → not added, not removed (case-insensitive match).
    expect(diff.add).not.toContain('cgao:kind/bug');
  });
});

describe('IssueTriageService (T-M3-001 end-to-end)', () => {
  const svc = new IssueTriageService();

  it('closed issues are ignored and never enter dev flow', () => {
    const d = svc.triage(snapshot({ closed: true, title: 'crash', body: 'bug repro' }));
    expect(d.status).toBe('ignored');
    expect(d.ignoredBecauseClosed).toBe(true);
    expect(d.labelsToAdd).toContain('cgao:status/ignored');
    // No kind label chosen for ignored issues.
    expect(d.labelsToAdd.find((l) => l.startsWith('cgao:kind/'))).toBeUndefined();
  });

  it('a complete bug routes to ready', () => {
    const body = [
      '## Steps to reproduce',
      'deploy',
      '## Expected',
      'green',
      '## Actual',
      'red',
    ].join('\n');
    const d = svc.triage(snapshot({ title: 'crash on deploy', body }));
    expect(d.category).toBe('bug');
    expect(d.status).toBe('ready');
    expect(d.missingFields).toEqual([]);
  });

  it('an incomplete bug routes to needs_info', () => {
    const d = svc.triage(snapshot({ title: 'crash', body: 'it broke' }));
    expect(d.status).toBe('needs_info');
    expect(d.missingFields.length).toBeGreaterThan(0);
  });

  it('security always routes to needs_info (human ack required)', () => {
    const d = svc.triage(snapshot({ title: 'CVE in auth', body: '## Affected component\nauth' }));
    expect(d.category).toBe('security');
    expect(d.status).toBe('needs_info');
  });

  it('a stale cgao:kind label from a human edit is removed when category changes', () => {
    const d = svc.triage(
      snapshot({
        title: 'crash on deploy',
        body: '## Steps to reproduce\ndeploy\n## Expected\ngreen\n## Actual\nred',
        existingLabels: ['cgao:kind/feature'],
      }),
    );
    expect(d.labelsToRemove).toContain('cgao:kind/feature');
    expect(d.labelsToAdd).toContain('cgao:kind/bug');
  });
});
