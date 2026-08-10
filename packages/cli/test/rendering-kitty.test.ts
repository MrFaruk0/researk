import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildKittyDeleteAll,
  buildKittyDeleteById,
  buildKittyPng,
  emitKittyPng,
  KITTY_IMAGE_ID,
  KITTY_PLACEMENT_ID,
} from "../src/rendering/kitty.js";

describe("Kitty graphics emitter", () => {
  it("chunks base64 payloads at 4096 bytes and emits deterministic placement controls", () => {
    const png = Uint8Array.from({ length: 4098 }, (_, index) => index % 251);
    const result = buildKittyPng(png, {
      row: 3,
      column: 4,
      columns: 7,
      rows: 2,
      // Unknown caller fields must not be interpolated into trusted controls.
      q: "q=0",
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.imageId).toBe(KITTY_IMAGE_ID);
    expect(result.placementId).toBe(KITTY_PLACEMENT_ID);
    expect(result.chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(result.sequence.startsWith("\u001b[s\u001b[3;4H")).toBe(true);
    expect(result.sequence).toContain("a=T,f=100,t=d,i=1,p=1,c=7,r=2,C=1,m=1,q=2;");
    expect(result.sequence).toContain("\u001b_Gm=0,q=2;");
    expect(result.sequence.match(/q=2/g)).toHaveLength(result.chunks.length);
    expect(result.sequence).not.toContain("q=0");
    expect(result.sequence.endsWith("\u001b[u")).toBe(true);
    expect(result.sequence).not.toContain("font");
    expect(buildKittyPng(png, { row: 3, column: 4, columns: 7, rows: 2 })).toEqual(result);
  });

  it("returns failures before writing when payload or dimensions exceed ceilings", async () => {
    const stdout = new PassThrough();
    const oversized = buildKittyPng(new Uint8Array(8 * 1024 * 1024 + 1));
    expect(oversized).toMatchObject({ ok: false, reason: "png-too-large" });
    expect(buildKittyPng(Uint8Array.of(1), { rows: 513 })).toMatchObject({
      ok: false,
      reason: "invalid-placement",
    });
    expect(buildKittyPng(Uint8Array.of(1), { imageId: 0 })).toMatchObject({
      ok: false,
      reason: "invalid-image-id",
    });
    const result = await emitKittyPng(stdout, Uint8Array.of(1), { columns: 0 });
    expect(result).toMatchObject({ ok: false, reason: "invalid-placement" });
    expect(stdout.read()).toBeNull();
  });

  it("exposes trusted delete-by-id and delete-all controls", () => {
    expect(buildKittyDeleteById(9)).toBe("\u001b_Ga=d,d=I,i=9,q=2\u001b\\");
    expect(buildKittyDeleteAll()).toBe("\u001b_Ga=d,d=A,q=2\u001b\\");
    expect(buildKittyDeleteById(0)).toBeUndefined();
  });
});
