export function escapeUnsafeTerminalControls(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const unsafe =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f);
    result += unsafe ? `\\u{${code.toString(16).padStart(4, "0")}}` : character;
  }
  return result;
}

/**
 * Removes the cursor-repositioning power of U+000D for a terminal display projection.
 *
 * `escapeUnsafeTerminalControls` intentionally preserves U+000D because the one-shot rendering path
 * feeds its output to `IncrementalMarkdownMathParser`, which strips a trailing `\r` to normalize
 * CRLF input. A carriage return is still an active control where text is actually drawn: it returns
 * the cursor to column zero, so untrusted text can overwrite an already-drawn line and spoof what
 * the user sees (`SAFE-PREFIX\rSPOOFED` displays as `SPOOFED`).
 *
 * A `\r\n` pair is collapsed to the `\n` that already ends the line, which is what a terminal shows
 * anyway, and a bare `\r` becomes a visible escape. Line structure is therefore unchanged and only
 * cursor motion is removed. This is a display-only transform: it must never be applied to canonical
 * source, and it is deliberately separate from `escapeUnsafeTerminalControls` so the one-shot parser
 * and its CRLF handling keep seeing raw carriage returns.
 */
export function neutralizeCarriageReturnsForDisplay(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\\u{000d}");
}

export function hasTerminalEscape(value: string): boolean {
  return value.includes("\u001b");
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

export class StreamingSecretRedactor {
  readonly #secrets: readonly string[];
  #pending = "";

  constructor(secrets: readonly string[]) {
    this.#secrets = secrets.filter((secret) => secret.length > 0);
  }

  push(value: string): string {
    const combined = this.#pending + value;
    const redacted = redactSecrets(combined, this.#secrets);
    const pendingLength = this.#longestSecretPrefixSuffix(redacted);
    this.#pending = pendingLength === 0 ? "" : redacted.slice(-pendingLength);
    return pendingLength === 0 ? redacted : redacted.slice(0, -pendingLength);
  }

  finish(): string {
    const result = redactSecrets(this.#pending, this.#secrets);
    this.#pending = "";
    return result;
  }

  #longestSecretPrefixSuffix(value: string): number {
    let longest = 0;
    for (const secret of this.#secrets) {
      const maximum = Math.min(secret.length - 1, value.length);
      for (let length = maximum; length > longest; length--) {
        if (value.endsWith(secret.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  }
}

export function safeTerminalText(value: string, secrets: readonly string[] = []): string {
  return escapeUnsafeTerminalControls(redactSecrets(value, secrets));
}

export function safeJson(value: unknown, secrets: readonly string[] = []): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "string" ? redactSecrets(item, secrets) : item,
  );
}

export function configuredSecretValues(
  env: Readonly<Record<string, string | undefined>>,
  reference: string,
  credentialValues: Readonly<Record<string, string>> = {},
): readonly string[] {
  const values = [env[reference], ...Object.values(credentialValues)];
  return [
    ...new Set(values.filter((value): value is string => value !== undefined && value.length > 0)),
  ];
}

export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  return safeTerminalText(error instanceof Error ? error.message : String(error), secrets);
}
