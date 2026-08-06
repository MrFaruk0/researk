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

export function hasTerminalEscape(value: string): boolean {
  return value.includes("\u001b");
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
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
): readonly string[] {
  const value = env[reference];
  return value === undefined || value.length === 0 ? [] : [value];
}

export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  return safeTerminalText(error instanceof Error ? error.message : String(error), secrets);
}
