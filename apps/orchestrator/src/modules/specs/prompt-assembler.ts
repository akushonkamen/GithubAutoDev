/**
 * Untrusted content envelope + prompt assembler — T-M4-002,
 * spec §6 + §12.4.
 *
 * cgao NEVER concatenates user content (issue body, comment body, PR
 * description) into a system instruction. The PromptAssembler enforces
 * this: every untrusted chunk is wrapped in the untrusted envelope
 * and appended AFTER the trusted system instruction, with a clear
 * boundary.
 *
 * Contracts (spec §6):
 *
 *   - User content appears ONLY inside <<<UNTRUSTED_CONTENT>>> blocks.
 *   - System instructions are trusted and appear BEFORE any envelope.
 *   - Forged closing delimiters inside user content are neutralized.
 *   - Multiple untrusted chunks each get their own envelope.
 */

export const UNTRUSTED_BEGIN = '<<<UNTRUSTED_CONTENT BEGIN>>>';
export const UNTRUSTED_END = '<<<UNTRUSTED_CONTENT END>>>';

export interface UntrustedChunk {
  /**
   * Short label for the chunk (e.g. 'ISSUE_BODY'). Helps the LLM
   * understand structure; the label itself is trusted (orchestrator-
   * supplied, not user content).
   */
  label: string;
  /** Raw user content. */
  content: string;
}

/**
 * Redact forged envelope delimiters inside untrusted content. If a
 * user writes "<<<<UNTRUSTED_CONTENT END>>>" in their body, the
 * forged delimiter is stripped so the model can't be tricked into
 * thinking the envelope ended early.
 *
 * Match liberally — any line containing the canonical begin/end
 * markers (with arbitrary leading/trailing whitespace) is replaced.
 */
export function redactForgedDelimiters(content: string): string {
  return content
    .replace(/<?<?<?<?(?:UNTRUSTED_CONTENT)?\s*(?:BEGIN|END)\s*>*>*>*>?/giu, '[redacted]')
    .replace(/<<<UNTRUSTED_CONTENT\s*(?:BEGIN|END)>>>/giu, '[redacted]');
}

/**
 * Wrap a single untrusted chunk in the envelope.
 */
export function wrapUntrustedChunk(chunk: UntrustedChunk): string {
  const redacted = redactForgedDelimiters(chunk.content);
  return [`--- ${chunk.label} (UNTRUSTED) ---`, UNTRUSTED_BEGIN, redacted, UNTRUSTED_END].join(
    '\n',
  );
}

export interface AssemblePromptInput {
  /** Trusted system instruction (the cgao role, rules, schema). */
  systemInstruction: string;
  /** Optional trusted scaffolding between system and untrusted. */
  bridgingInstruction?: string;
  /** Untrusted chunks (issue body, comment bodies, etc). */
  untrusted: readonly UntrustedChunk[];
  /** Optional trusted trailer (output format, final reminder). */
  trailerInstruction?: string;
}

/**
 * Assemble a full prompt. Guarantees:
 *
 *   1. systemInstruction appears FIRST.
 *   2. Each untrusted chunk is wrapped.
 *   3. Trailer appears LAST.
 *   4. No untrusted content appears OUTSIDE an envelope.
 */
export function assemblePrompt(input: AssemblePromptInput): string {
  const parts: string[] = [input.systemInstruction];
  if (input.bridgingInstruction) parts.push(input.bridgingInstruction);
  for (const chunk of input.untrusted) {
    parts.push(wrapUntrustedChunk(chunk));
  }
  if (input.trailerInstruction) parts.push(input.trailerInstruction);
  return parts.join('\n\n');
}

/**
 * Verify that no untrusted content appears outside an envelope in
 * the assembled prompt. Used by tests as a structural invariant.
 */
export function assertNoUntrustedLeak(args: {
  prompt: string;
  untrustedContents: readonly string[];
}): { leaked: boolean; samples: readonly string[] } {
  const beginIdx = args.prompt.indexOf(UNTRUSTED_BEGIN);
  const endIdx = args.prompt.lastIndexOf(UNTRUSTED_END);
  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    return { leaked: args.untrustedContents.length > 0, samples: args.untrustedContents };
  }
  const before = args.prompt.slice(0, beginIdx);
  const after = args.prompt.slice(endIdx + UNTRUSTED_END.length);
  const samples: string[] = [];
  for (const c of args.untrustedContents) {
    const firstNeedle = c.slice(0, Math.min(20, c.length));
    if (firstNeedle && (before.includes(firstNeedle) || after.includes(firstNeedle))) {
      samples.push(c);
    }
  }
  return { leaked: samples.length > 0, samples };
}
