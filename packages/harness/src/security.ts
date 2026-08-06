export const DEFAULT_UNTRUSTED_TEXT_LIMIT = 4_096;

export function sanitizeUntrustedText(value: string, limit = DEFAULT_UNTRUSTED_TEXT_LIMIT): string {
  const safeLimit = Math.max(0, limit);

  return stripTerminalControls(value).slice(0, safeLimit);
}

function stripTerminalControls(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const kind = value.charCodeAt(index + 1);
      index += 1;
      if (kind === 0x5b) {
        while (index + 1 < value.length) {
          index += 1;
          const current = value.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
        }
      } else if (kind === 0x5d) {
        while (index + 1 < value.length) {
          index += 1;
          const current = value.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
        }
      }
      continue;
    }
    const disallowed =
      code <= 0x08 ||
      (code >= 0x0b && code <= 0x0c) ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f);
    if (!disallowed) result += value.charAt(index);
  }
  return result;
}

export function sanitizeSafeText(value: string, limit = DEFAULT_UNTRUSTED_TEXT_LIMIT): string {
  const sanitized = sanitizeUntrustedText(value, limit).replace(/\s+/gu, " ").trim();
  return sanitized.length === 0 ? "Unspecified" : sanitized;
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;

  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }

  return redacted.replace(
    /\b(authorization|api[-_ ]?key|token)\b\s*[:=]\s*[^\s,;]+/giu,
    "$1=[REDACTED]",
  );
}

export function normalizeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeSafeText(redactSecrets(message, secrets));
}
