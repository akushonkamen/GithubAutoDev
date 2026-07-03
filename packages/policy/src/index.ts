/**
 * @cgao/policy — Policy definitions and evaluator.
 *
 * Per spec §4.5 (SHA-bound gates), §12.11 (protected files), §13 (runner
 * permission profiles). This package owns the *declarative* policy surface:
 * gate kinds, decision types, and a pure evaluator stub that M2 will wire
 * into the orchestrator's authoritative decision path.
 */

import { z } from 'zod';

export type PolicyDecision = 'allow' | 'deny' | 'needs_review';

export const policyDecisionSchema = z.enum(['allow', 'deny', 'needs_review']);

export interface PolicyContext {
  /** GitHub repo in `owner/name` form. */
  repo: string;
  /** Workflow run lookup key (spec §4.4). */
  runId: string | null;
  /** SHA-bound gate heads, filled by M2 (spec §4.5). */
  gates?: {
    spec?: string;
    plan?: string;
    approval?: string;
    head?: string;
    base?: string;
  };
  /** Protected file paths touched by the change (spec §12.11). */
  protectedFilesTouched?: readonly string[];
}

export interface PolicyEvaluator {
  evaluate(ctx: PolicyContext): PolicyDecision;
}

/**
 * M0 stub. Real policy logic lands in M2 (T-M2-*) once the state machine and
 * artifact store are wired. For now we return `needs_review` for any context
 * with protected-files touch — the only non-trivial rule we can decide today.
 */
export function evaluatePolicy(ctx: PolicyContext): PolicyDecision {
  if (ctx.protectedFilesTouched && ctx.protectedFilesTouched.length > 0) {
    return 'needs_review';
  }
  return 'allow';
}
