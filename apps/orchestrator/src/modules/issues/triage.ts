/**
 * Issue triage rule engine — T-M3-001, spec §12.3.
 *
 * IssueClassifier consumes an issue body + advisory hints (from intake
 * classifier or LLM) and produces an authoritative category. The
 * InformationCompletenessRules check whether we have enough signal to
 * route the issue into the dev flow; otherwise we set NEEDS_INFO.
 * StatusProjectionService maps internal state onto the GitHub
 * `cgao:status/*` label surface so humans can see what cgao thinks.
 *
 * Contracts (spec §12.3):
 *
 *   - Closed issues NEVER enter the dev flow — the rule engine refuses
 *     to classify them and returns status=ignored.
 *   - The classifier output is the AUTHORITATIVE source for the
 *     cgao:kind/* label. LLM hints from intake are advisory only.
 *   - Information sufficiency is policy-driven: this is the chokepoint
 *     where missing-fields diverges from "ship it".
 */

import { z } from 'zod';

export const issueCategorySchema = z.enum([
  'bug',
  'feature',
  'docs',
  'question',
  'security',
  'chore',
  'unknown',
]);
export type IssueCategory = z.infer<typeof issueCategorySchema>;

export const issueStatusSchema = z.enum([
  'new',
  'triaging',
  'needs_info',
  'ready',
  'in_progress',
  'blocked',
  'reviewing',
  'closed',
  'ignored',
]);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

export interface IssueSnapshot {
  number: number;
  title: string;
  body: string;
  /** True when GitHub webhook fired on a closed issue. */
  closed: boolean;
  /** Existing labels at the time of triage, lowercased. */
  existingLabels: readonly string[];
  /** Author login (display only — never authoritative for permission). */
  authorLogin: string;
}

export interface TriageHints {
  /** From intake classifier (advisory). */
  categoryHint?: IssueCategory;
  severityHint?: 'low' | 'medium' | 'high' | 'unknown';
  /** LLM-derived confidence 0..1, used to gate NEEDS_INFO. */
  confidence?: number;
}

export interface InformationRule {
  /** Category this rule applies to. */
  category: IssueCategory;
  /**
   * Returns a list of missing field names. Empty array means we have
   * enough info. Pure: caller passes the snapshot + hints.
   */
  missingFields(snapshot: IssueSnapshot, hints: TriageHints): readonly string[];
}

export interface TriageDecision {
  category: IssueCategory;
  status: IssueStatus;
  /** Labels the orchestrator should set, e.g. ['cgao:kind/bug','cgao:status/needs_info']. */
  labelsToAdd: readonly string[];
  /** Labels to remove (e.g. a stale cgao:kind/* from human edit). */
  labelsToRemove: readonly string[];
  /** When status=needs_info, the missing fields are listed here. */
  missingFields: readonly string[];
  /** True when the closed-issue short-circuit fired. */
  ignoredBecauseClosed: boolean;
}

/**
 * Default keyword → category mapping used when no advisory hint is
 * present (or the hint has low confidence). Keywords are matched
 * case-insensitively against the title + body.
 */
const KEYWORD_MAP: ReadonlyArray<{ category: IssueCategory; keywords: readonly string[] }> = [
  {
    category: 'security',
    keywords: [
      'security',
      'cve',
      'vulnerability',
      'exploit',
      'xss',
      'sqli',
      'rce',
      'privilege escalation',
    ],
  },
  {
    category: 'bug',
    keywords: ['bug', 'crash', 'broken', 'error', 'exception', 'failed', 'regression', 'panic'],
  },
  {
    category: 'feature',
    keywords: ['feature', 'request', 'add support', 'would be nice', 'enhancement', 'proposal'],
  },
  {
    category: 'docs',
    keywords: ['docs', 'documentation', 'readme', 'typo', 'spelling', 'example'],
  },
  {
    category: 'question',
    keywords: ['how do i', 'how to', 'question', '?', 'help me understand'],
  },
  {
    category: 'chore',
    keywords: ['chore', 'refactor', 'cleanup', 'upgrade', 'dependency', 'bump version'],
  },
];

const MIN_CONFIDENCE_FOR_HINT = 0.6;

export class IssueClassifier {
  /**
   * Decide the authoritative category for an issue. Pure function of
   * (snapshot, hints). Rules in order:
   *
   *   1. If the issue is closed → status=ignored, no category chosen.
   *   2. If the advisory hint is high-confidence AND maps cleanly to a
   *      category, use it.
   *   3. Otherwise keyword-match the title+body.
   *   4. Default to 'unknown' (which becomes needs_info).
   */
  classify(snapshot: IssueSnapshot, hints: TriageHints = {}): IssueCategory {
    if (snapshot.closed) return 'unknown';
    if (
      hints.categoryHint &&
      hints.categoryHint !== 'unknown' &&
      (hints.confidence ?? 0) >= MIN_CONFIDENCE_FOR_HINT
    ) {
      return hints.categoryHint;
    }
    return keywordCategory(snapshot.title, snapshot.body);
  }
}

export function keywordCategory(title: string, body: string): IssueCategory {
  const text = `${title}\n${body}`.toLowerCase();
  for (const { category, keywords } of KEYWORD_MAP) {
    for (const kw of keywords) {
      if (!kw) continue;
      // word-boundary match for alphabetic keywords; substring for
      // punctuation like '?'.
      if (kw.length === 1 || /\W/u.test(kw[0] ?? '')) {
        if (text.includes(kw)) return category;
      } else {
        const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'u');
        if (re.test(text)) return category;
      }
    }
  }
  return 'unknown';
}

/**
 * Default completeness rules. Each rule is a small, named policy:
 *
 *   bug       — needs steps-to-reproduce + expected/actual
 *   feature   — needs user-story + acceptance signal
 *   security  — needs affected-component + severity (always needs_info
 *               until a human acknowledges — defense in depth)
 *   question  — never needs_info (one-shot)
 *   docs      — needs location + intended change
 *   chore     — needs scope statement
 *   unknown   — needs anything descriptive
 */
export class InformationCompletenessRules {
  private readonly rules: ReadonlyArray<InformationRule>;

  constructor(customRules?: InformationRule[]) {
    this.rules = customRules ?? DEFAULT_RULES;
  }

  evaluate(
    category: IssueCategory,
    snapshot: IssueSnapshot,
    hints: TriageHints,
  ): readonly string[] {
    for (const rule of this.rules) {
      if (rule.category !== category) continue;
      return rule.missingFields(snapshot, hints);
    }
    return [];
  }
}

const hasBodyField = (body: string, label: string, synonyms: readonly string[] = []): boolean => {
  const needles = [label, ...synonyms].map((n) => n.toLowerCase());
  const lower = body.toLowerCase();
  for (const n of needles) {
    if (!n) continue;
    // Allow optional markdown header hashes / list bullets before the label.
    const re = new RegExp(`(^|\\n)\\s*[#*\\-]*\\s*${escapeRegex(n)}\\b[:：]?`, 'u');
    if (re.test(lower)) return true;
  }
  return false;
};

const hasMention = (body: string, word: string): boolean => {
  const re = new RegExp(`\\b${escapeRegex(word.toLowerCase())}\\b`, 'u');
  return re.test(body.toLowerCase());
};

const DEFAULT_RULES: ReadonlyArray<InformationRule> = [
  {
    category: 'bug',
    missingFields: (s) => {
      const out: string[] = [];
      if (
        !hasBodyField(s.body, 'steps to reproduce', ['repro', 'reproduction', 'how to reproduce'])
      ) {
        out.push('steps_to_reproduce');
      }
      if (!hasBodyField(s.body, 'expected', ['expected behavior', 'expected result'])) {
        out.push('expected_behavior');
      }
      if (!hasBodyField(s.body, 'actual', ['actual behavior', 'observed']))
        out.push('actual_behavior');
      return out;
    },
  },
  {
    category: 'feature',
    missingFields: (s) => {
      const out: string[] = [];
      if (!hasBodyField(s.body, 'user story', ['as a', 'as an'])) out.push('user_story');
      if (!hasBodyField(s.body, 'acceptance', ['acceptance criteria', 'definition of done'])) {
        out.push('acceptance_criteria');
      }
      return out;
    },
  },
  {
    category: 'security',
    missingFields: (s, hints) => {
      const out: string[] = [];
      if (!hasBodyField(s.body, 'affected', ['affected component', 'affected versions'])) {
        out.push('affected_component');
      }
      if (hints.severityHint === 'unknown' || !hints.severityHint) out.push('severity');
      // Security is ALWAYS needs_info until a human ack — defense in depth.
      out.push('human_ack_required');
      return out;
    },
  },
  {
    category: 'docs',
    missingFields: (s) => {
      const out: string[] = [];
      if (!hasMention(s.body, 'readme') && !hasBodyField(s.body, 'location', ['path', 'file'])) {
        out.push('location');
      }
      return out;
    },
  },
  {
    category: 'chore',
    missingFields: (s) => {
      if (!hasBodyField(s.body, 'scope', ['what changes', 'scope of work'])) return ['scope'];
      return [];
    },
  },
  {
    category: 'question',
    missingFields: () => [],
  },
  {
    category: 'unknown',
    missingFields: (s) => (s.body.trim().length < 20 ? ['description'] : []),
  },
];

const CGAO_KIND_PREFIX = 'cgao:kind/';
const CGAO_STATUS_PREFIX = 'cgao:status/';

/**
 * Map internal status to the cgao:status/* label surface.
 */
export class StatusProjectionService {
  statusLabel(status: IssueStatus): string {
    return `${CGAO_STATUS_PREFIX}${status}`;
  }

  kindLabel(category: IssueCategory): string {
    return `${CGAO_KIND_PREFIX}${category}`;
  }

  /**
   * Diff the issue's existing labels against the desired authoritative
   * set and return add/remove lists. Existing labels NOT prefixed with
   * cgao: are left untouched — humans may add their own labels freely.
   */
  diffLabels(
    existing: readonly string[],
    desired: { category: IssueCategory; status: IssueStatus },
  ): { add: readonly string[]; remove: readonly string[] } {
    const lower = new Set(existing.map((l) => l.toLowerCase()));
    const want = new Set<string>([
      this.kindLabel(desired.category).toLowerCase(),
      this.statusLabel(desired.status).toLowerCase(),
    ]);
    const add: string[] = [];
    const remove: string[] = [];
    for (const l of want) {
      if (!lower.has(l)) add.push(l);
    }
    for (const l of lower) {
      if ((l.startsWith(CGAO_KIND_PREFIX) || l.startsWith(CGAO_STATUS_PREFIX)) && !want.has(l)) {
        remove.push(l);
      }
    }
    return { add, remove };
  }
}

/**
 * The triage orchestrator. Combines the three services above into a
 * single decision: closed-issue short-circuit → classify → check
 * completeness → emit labels.
 */
export class IssueTriageService {
  constructor(
    private readonly classifier: IssueClassifier = new IssueClassifier(),
    private readonly completeness: InformationCompletenessRules = new InformationCompletenessRules(),
    private readonly projection: StatusProjectionService = new StatusProjectionService(),
  ) {}

  triage(snapshot: IssueSnapshot, hints: TriageHints = {}): TriageDecision {
    // 1. Closed issues never enter the dev flow.
    if (snapshot.closed) {
      return {
        category: 'unknown',
        status: 'ignored',
        labelsToAdd: [this.projection.statusLabel('ignored')],
        labelsToRemove: this.staleCgaoLabels(snapshot.existingLabels, { statusOnly: true }),
        missingFields: [],
        ignoredBecauseClosed: true,
      };
    }

    // 2. Classify.
    const category = this.classifier.classify(snapshot, hints);

    // 3. Completeness check.
    const missing = this.completeness.evaluate(category, snapshot, hints);
    const status: IssueStatus = missing.length === 0 ? 'ready' : 'needs_info';

    // 4. Project to labels.
    const desired = { category, status };
    const diff = this.projection.diffLabels(snapshot.existingLabels, desired);

    return {
      category,
      status,
      labelsToAdd: diff.add,
      labelsToRemove: diff.remove,
      missingFields: missing,
      ignoredBecauseClosed: false,
    };
  }

  private staleCgaoLabels(
    existing: readonly string[],
    opts: { statusOnly?: boolean },
  ): readonly string[] {
    const out: string[] = [];
    for (const l of existing) {
      const lower = l.toLowerCase();
      if (opts.statusOnly && lower.startsWith(CGAO_STATUS_PREFIX)) {
        if (!lower.endsWith('/ignored')) out.push(lower);
      }
    }
    return out;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
