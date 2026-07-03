/**
 * Untrusted content envelope — T-INTAKE-007, spec §6 / §12.0 / §12.4.
 *
 * All IM message bodies, issue bodies, and PR descriptions are
 * attacker-controlled. They MUST pass through wrapUntrusted() before
 * being concatenated into any LLM prompt. scanForInjection() is a
 * pre-flight: if it detects obvious injection patterns, callers
 * refuse to construct the prompt at all (defense-in-depth — the
 * envelope is still the primary defense).
 *
 * The envelope is intentionally verbose so that downstream prompt
 * templates can be audited: any place user content is interpolated
 * without going through wrapUntrusted() is a bug.
 */

export interface UntrustedEnvelope {
  /** The original text, untouched. */
  raw: string;
  /** The wrapped text, ready to interpolate into an LLM prompt. */
  wrapped: string;
  /** Output of scanForInjection(raw). */
  injection: InjectionScanResult;
}

export interface InjectionScanResult {
  /** True if any obvious injection signature was detected. */
  suspicious: boolean;
  /** Categorized signals, each with the matched substring and offset. */
  signals: InjectionSignal[];
}

export interface InjectionSignal {
  kind:
    | 'override_instruction'
    | 'system_role_marker'
    | 'ignore_previous'
    | 'assistant_role_marker'
    | 'tool_call_pattern'
    | 'markdown_image_hidden'
    | 'codeblock_escape';
  /** Matched substring from the original text. */
  match: string;
  /** 0-based offset in the original text. */
  start: number;
}

interface Pattern {
  kind: InjectionSignal['kind'];
  regex: RegExp;
}

const INJECTION_PATTERNS: ReadonlyArray<Pattern> = [
  // "Ignore previous instructions" and variants.
  {
    kind: 'ignore_previous',
    regex:
      /\b(?:ignore|disregard|forget)\b[^.!\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.!\n]{0,40}\b(?:instructions?|rules?|prompts?|directives?)\b/giu,
  },
  // Explicit override attempts in any case.
  {
    kind: 'override_instruction',
    regex:
      /\b(?:you must|you are now|new instruction|act as|from now on|stop following|your new role)\b/giu,
  },
  // System / developer role markers users might spoof.
  { kind: 'system_role_marker', regex: /(?:^|\n)\s*<\s*(?:system|developer|tool|function)\s*>/giu },
  // Assistant role markers users might spoof to fake an assistant reply.
  { kind: 'assistant_role_marker', regex: /(?:^|\n)\s*<\s*assistant\s*>/giu },
  // Tool / function call JSON the user is trying to inject as if it were the model's own output.
  { kind: 'tool_call_pattern', regex: /\{[\s\S]{0,80}?(?:tool|function|name)[\s\S]{0,200}?\}/gu },
  // Markdown image with a data URL — can exfiltrate or hide payloads.
  { kind: 'markdown_image_hidden', regex: /!\[[^\]]*\]\(\s*data:/giu },
  // Triple-backtick escape attempt to break out of code blocks.
  {
    kind: 'codeblock_escape',
    regex: /```[\s\S]{0,40}?(?:system|assistant|tool|ignore)[\s\S]{0,40}?```/giu,
  },
];

export function scanForInjection(text: string): InjectionScanResult {
  const signals: InjectionSignal[] = [];
  for (const { kind, regex } of INJECTION_PATTERNS) {
    regex.lastIndex = 0;
    for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
      signals.push({ kind, match: m[0], start: m.index });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  }
  signals.sort((a, b) => a.start - b.start);
  return { suspicious: signals.length > 0, signals };
}

const BEGIN = '<<<UNTRUSTED_CONTENT BEGIN>>>';
const END = '<<<UNTRUSTED_CONTENT END>>>';

/**
 * Wrap attacker-controlled text with hard delimiters. The wrapped text
 * is what gets interpolated into the LLM prompt:
 *
 *   <<<UNTRUSTED_CONTENT BEGIN>>>
 *   ...user content verbatim...
 *   <<<UNTRUSTED_CONTENT END>>>
 *
 * The delimiters are intentionally ugly-unique so they don't collide
 * with normal prose and so a `grep UNTRUSTED_CONTENT` over the prompt
 * template surfaces every place that interpolates user content.
 *
 * The content is *not* transformed — the LLM sees it verbatim, but with
 * clear markings that this is untrusted data and must not be obeyed as
 * instructions.
 */
export function wrapUntrusted(text: string): string {
  // Strip any attempt by the user to inject the delimiter itself.
  // (Defense in depth: the LLM is also instructed to treat the
  // outermost delimiters as authoritative.)
  const sanitized = text.replace(
    /<<<UNTRUSTED_CONTENT\s*(?:BEGIN|END)>>>/gu,
    '<<<REDACTED_ENVELOPE_DELIMITER>>>',
  );
  return `${BEGIN}\n${sanitized}\n${END}`;
}

export function envelope(text: string): UntrustedEnvelope {
  return {
    raw: text,
    wrapped: wrapUntrusted(text),
    injection: scanForInjection(text),
  };
}

/** Predicate for callers that want to short-circuit prompt construction. */
export function looksLikeInjection(text: string): boolean {
  return scanForInjection(text).suspicious;
}
