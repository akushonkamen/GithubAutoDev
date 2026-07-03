/**
 * commitlint — enforce CGAO commit format.
 *
 *   T-M{milestone}-{seq} {scope}: {imperative summary}
 *
 * Examples:
 *   T-M0-001 packages: add policy skeleton
 *   T-M1-003 events: map issue.opened to CloudEvents
 *   T-M0-audit docs: reconcile T-M0-001..005 completion
 *   T-INTAKE-005 intake: dedup messages
 *   chore(deps): bump hono
 *
 * Scope may appear as a space-separated word (`packages: ...`) or in
 * conventional parens (`(packages): ...`). Both are accepted.
 */

const CGAO_HEADER =
  /^(T-(?:M\d+-(?:\d+|audit)|INTAKE-\d+)|chore|docs)(?:\s+|\()(?:[a-z0-9-_]+)\)?!?: .+$/;

/** @type {import('@commitlint/types').UserConfig} */
export default {
  plugins: [
    {
      rules: {
        'cgao-task-id': ({ header }) => {
          return [
            CGAO_HEADER.test(header ?? ''),
            'header must match `<T-Mx-xxx|T-INTAKE-xxx|chore|docs> <scope>: <summary>` (e.g. `T-M0-001 packages: add skeleton`)',
          ];
        },
      },
    },
  ],
  rules: {
    'cgao-task-id': [2, 'always'],
    'header-max-length': [2, 'always', 100],
    'header-min-length': [2, 'always', 10],
    'body-leading-blank': [1, 'always'],
    // Disable conventional defaults that don't fit our task-ID scheme.
    'type-empty': [0],
    'type-enum': [0],
    'type-case': [0],
    'scope-empty': [0],
    'scope-case': [0],
    'subject-empty': [0],
    'subject-case': [0],
    'subject-full-stop': [0],
  },
};
