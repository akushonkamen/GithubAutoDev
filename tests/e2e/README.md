# @cgao/e2e-tests — Plan A end-to-end integration suite

This package proves the cgao modules compose into a working system. It
drives the **real production pipeline top-to-bottom**, with fakes only
at the four external boundaries:

| Boundary      | Fake                    | Production replacement            |
| ------------- | ----------------------- | --------------------------------- |
| GitHub API    | `FakeGitHubClient`      | Octokit on a GitHub App credential |
| git CLI       | `FakeGitPort`           | real `git` subprocess port         |
| Agent runner  | `FakeRunnerQueue`       | Claude Code via runner-broker      |
| LLM           | benign inline stubs     | Anthropic SDK via runner-broker    |

Everything else (event bus, audit chain, artifact store, db repos,
branch/commit/PR/review/merge services, gate aggregator, final
evaluator, checkpoint verifier) is the **real production code**.

## What the suite proves

`src/__tests__/happy-path.test.ts` drives one full workflow run from
webhook to merge and asserts at each gate:

1. `intake.classify` — explicit-trigger fast path returns ready.
2. `generateRequirementSpec` — deterministic spec from the issue snapshot.
3. `buildImplementationPlan` — schema-parsed plan covering every acceptance criterion.
4. `buildHandoff` (×2) — analysis→plan and plan→dev hash-chained artifacts.
5. `BranchService.create` — fake git returns baseSha; branch is idempotent.
6. `CommitBuilder.build` — canned WorkerResult patch applied through the
   M5 clean-checkout applier; protected-file sweep passes.
7. `PullRequestService.createPr` — fake GitHub returns PR #1; dedup
   proves the second call reuses the same PR.
8. `ReviewRunner.run` + `SecurityReviewRunner.run` — benign LLM stubs;
   zero blocking findings; ReviewResult bound to headSha.
9. `GateAggregator.aggregate` — `mergeable=true`.
10. `MergeFinalEvaluator.evaluate` — `decision='merge'`.
11. `MergeService.merge` + `IssueCloseService.close` — fake GitHub
    records `pr.merge`, `issue.close`, `issue.label.remove` (×N),
    `issue.comment.add` in spec order.
12. `CheckpointVerifier.verify` — audit chain intact end-to-end.
13. FakeGitHubClient mutation log order matches the spec flow.

`src/__tests__/drift-negative.test.ts` runs the same setup, then
force-pushes a new head sha between gate-pass and merge. The final
evaluator MUST yield `decision='refuse'` and the merge service MUST
NOT record a `pr.merge` mutation.

## How to run

```sh
pnpm install --offline          # refresh workspace links
pnpm --filter @cgao/e2e-tests test
```

Or, from the repo root:

```sh
pnpm -r typecheck               # all packages, including this one
pnpm -r test                    # the existing 775 unit tests + e2e
```

## How to extend

The shared wiring lives in `src/fixtures/happy-path-fixture.ts`. Construct a
fresh fixture per test scenario with `buildHappyPathFixture(config)` and
override only the fields you care about. The fixture returns every
production service already wired against the fakes.

Add a new fake by implementing the existing port interface
(`GitPort`, `GitHubPrPort`, `MergeExecutionPort`, `IssueClosePort`,
`TrustedGitHubPrPort`, `AgentRunQueue`, `ReviewerLlmPort`, etc.) and
swapping it into the fixture.

## What this is NOT

This is **NOT** a real GitHub App run. There is no network, no real
git, no real Claude. Plan B wires the real GitHub App: Octokit on a
GitHub App credential, real git subprocess, real Claude Code via
runner-broker. The e2e suite proves the modules compose so Plan B's
work is purely adapter wiring.
