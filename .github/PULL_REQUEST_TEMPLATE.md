## Summary

<!-- What does this PR change and why -->

## Spec / Task reference

- Spec section: docs/cgao_spec_v3.md §
- Task: docs/cgao_tasklist_v3.md T-

## SHA-bound gates

- [ ] spec_sha bound
- [ ] plan_sha bound (if ImplementationPlan touched)
- [ ] approval_sha bound (if plan approval flow)
- [ ] head_sha / base_sha pinned in evaluator

## Security checklist

- [ ] No new secret passed to Untrusted Code Runner
- [ ] User content wrapped in untrusted envelope before LLM
- [ ] Signature verification stays in Trusted Control Runner
- [ ] No `--no-verify`, no skip of pre-commit / pre-merge hooks
- [ ] Audit hash chain extended for any new authoritative action

## Test plan

- [ ] `pnpm test` green
- [ ] `pnpm typecheck` green
- [ ] `pnpm lint` green
- [ ] Relevant P0 security regression test added/updated
