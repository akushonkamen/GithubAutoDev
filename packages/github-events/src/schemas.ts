/**
 * Per-event-type payload schemas (T-M1-003).
 *
 * Each schema covers ONLY the fields CGAO reads. Unknown fields are
 * ignored (Zod default), preserving forward-compat with GitHub event
 * additions. Stricter parsing happens at the orchestrator boundary.
 */

import { z } from 'zod';

export const issueOpenedSchema = z.object({
  action: z.literal('opened'),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    html_url: z.string().url(),
  }),
  repository: z.object({
    name: z.string(),
    full_name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

export const issuesLabeledSchema = z.object({
  action: z.literal('labeled'),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    html_url: z.string().url(),
  }),
  label: z.object({ name: z.string() }),
  repository: z.object({
    name: z.string(),
    full_name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

export const issueCommentCreatedSchema = z.object({
  action: z.literal('created'),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.object({ url: z.string().url() }).optional(),
  }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string(),
    user: z.object({ login: z.string() }),
  }),
  repository: z.object({
    name: z.string(),
    full_name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

export const pullRequestSynchronizeSchema = z.object({
  action: z.literal('synchronize'),
  number: z.number().int().positive(),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string().length(40) }),
    base: z.object({ sha: z.string().length(40) }),
  }),
  repository: z.object({
    name: z.string(),
    full_name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

export const workflowRunCompletedSchema = z.object({
  action: z.literal('completed'),
  workflow_run: z.object({
    id: z.number().int().positive(),
    head_sha: z.string().length(40),
    conclusion: z.enum([
      'success',
      'failure',
      'cancelled',
      'skipped',
      'timed_out',
      'action_required',
    ]),
    html_url: z.string().url(),
  }),
  repository: z.object({
    name: z.string(),
    full_name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});
