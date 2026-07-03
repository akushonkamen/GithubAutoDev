/**
 * Secret leak scan — attack-scenarios/runner-exfiltration.md §5,
 * FORBIDDEN_SECRET_PATTERNS contract from @cgao/test-utils.
 *
 * Walks the repo source tree (excluding node_modules, .git, dist,
 * test fixture safe-harbors) and asserts no live secret material
 * has been accidentally committed. This is a tripwire, not a
 * replacement for git-secrets / pre-commit.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FORBIDDEN_SECRET_PATTERNS } from '@cgao/test-utils';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(process.cwd(), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.omc', '.claude']);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir, 'utf8');
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (st.isFile() && !name.endsWith('.lock')) {
      yield p;
    }
  }
}

function scan(): { path: string; line: number; pattern: string; line_text: string }[] {
  const hits: { path: string; line: number; pattern: string; line_text: string }[] = [];
  for (const file of walk(REPO_ROOT)) {
    if (
      file.includes('security-tests') ||
      file.includes('test-utils/src/fixtures') ||
      file.includes('tests/fixtures/') || // synthetic attack-corpus fixtures
      file.includes('__tests__/redaction.test.ts') || // redaction corpus — synthetic secrets
      file.includes('packages/artifacts/src/__tests__/redaction.test.ts')
    ) {
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
        if (pattern.test(line)) {
          hits.push({ path: file, line: i + 1, pattern: String(pattern), line_text: line });
        }
      }
    }
  }
  return hits;
}

describe('repo secret leak scan', () => {
  it('finds no live secrets in source tree', () => {
    const hits = scan();
    if (hits.length > 0) {
      console.error('Secret-pattern hits:', JSON.stringify(hits, null, 2));
    }
    expect(hits).toHaveLength(0);
  });
});
