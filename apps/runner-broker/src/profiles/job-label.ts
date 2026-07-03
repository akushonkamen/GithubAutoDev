/**
 * Canonical runner job labels — T-M5-003, spec §13 / §17.
 *
 * Each label maps to a GitHub Actions job name and to a credential
 * profile (trusted vs untrusted). The runner-broker uses this map to
 * decide which env to scrub/inject before dispatch.
 *
 * Contracts (spec §13):
 *
 *   - Trusted Control Runner: analyst, planner, reviewer, committer
 *     (need GitHub write + audit). NOT exposed to repo code beyond
 *     what the prompt carries.
 *   - Untrusted Code Runner: executor, explorer, tester (run repo
 *     code). No GitHub write token, no Anthropic key, no artifact
 *     write token.
 */

export const JOB_LABELS = [
  'analyst',
  'planner',
  'executor',
  'reviewer',
  'committer',
  'explorer',
  'tester',
] as const;

export type JobLabel = (typeof JOB_LABELS)[number];

export function isJobLabel(value: string): value is JobLabel {
  return (JOB_LABELS as readonly string[]).includes(value);
}

/**
 * CCA command → job label. The CCA workflow accepts `client_payload.command`
 * ∈ {analyst, planner, executor, reviewer}; we map the broader label set
 * onto those four commands for the dispatch surface.
 */
export const CCA_COMMANDS = ['analyst', 'planner', 'executor', 'reviewer'] as const;
export type CcaCommand = (typeof CCA_COMMANDS)[number];

export function ccaCommandFor(label: JobLabel): CcaCommand {
  switch (label) {
    case 'analyst':
    case 'planner':
    case 'executor':
    case 'reviewer':
      return label;
    case 'committer':
      return 'reviewer';
    case 'explorer':
    case 'tester':
      return 'executor';
  }
}
