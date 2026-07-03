# malicious-package-json fixture

Regression fixture for **T-M6-004 — package script exfiltration**.

The `pretest`, `test`, and `posttest` scripts in `package.json` each
emit any value they find in a sensitive env var (`GITHUB_TOKEN`,
`ANTHROPIC_API_KEY`, `CGAO_ARTIFACT_WRITE_TOKEN`). When the runner
spawns `pnpm test` under the **NoSecretExecutionProfile** (env scrubbed
via `scrubRunnerEnv`), none of those vars are present, so each script
prints an empty string. The persisted gate log must therefore contain
no live secret material — verified by the corresponding security
regression at `tests/security/src/__tests__/package-script-exfiltration.test.ts`.

This fixture is intentionally inert when the env is clean: every script
falls back to `||''` so simply `npm install && npm test` here is a
no-op. Do not add this fixture to the root workspace.
