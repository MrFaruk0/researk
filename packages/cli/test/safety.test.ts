import { describe, expect, it } from "vitest";
import { redactSecrets, StreamingSecretRedactor } from "../src/safety.js";

function partitions(value: string): readonly (readonly string[])[] {
  if (value.length === 0) return [[]];
  const results: string[][] = [];
  const visit = (offset: number, chunks: string[]) => {
    if (offset === value.length) {
      results.push(chunks);
      return;
    }
    for (let end = offset + 1; end <= value.length; end++) {
      visit(end, [...chunks, value.slice(offset, end)]);
    }
  };
  visit(0, []);
  return results;
}

function streamRedact(chunks: readonly string[], secrets: readonly string[]): string {
  const redactor = new StreamingSecretRedactor(secrets);
  return chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.finish();
}

describe("StreamingSecretRedactor", () => {
  it.each([
    { secret: "abab", value: "xababababz" },
    { secret: "aaaa", value: "xaaaaaaaaz" },
  ])(
    "never emits repeated-prefix secret $secret across any chunk partition",
    ({ secret, value }) => {
      const expected = redactSecrets(value, [secret]);

      for (const chunks of partitions(value)) {
        const output = streamRedact(chunks, [secret]);
        expect(output, JSON.stringify(chunks)).toBe(expected);
        expect(output, JSON.stringify(chunks)).not.toContain(secret);
      }
    },
  );

  it("preserves ordinary text while buffering only an incomplete secret prefix", () => {
    const redactor = new StreamingSecretRedactor(["secret"]);

    expect(redactor.push("ordinary se")).toBe("ordinary ");
    expect(redactor.push("cret text")).toBe("[REDACTED] text");
    expect(redactor.finish()).toBe("");
  });
});
