import { describe, expect, it } from "bun:test";
import { canonicalize, computeCanonicalSha256 } from "../../../src/domain/utils/canonical-json";

describe("Canonical JSON & Idempotency", () => {
  it("should generate the exact same canonical string and SHA-256 regardless of key order", () => {
    const payloadA = {
      roundId: "round-99",
      amount: "25.00",
      player: { id: "p-1", vip: true },
    };
    const payloadB = {
      player: { vip: true, id: "p-1" },
      amount: "25.00",
      roundId: "round-99",
    };
    const strA = canonicalize(payloadA);
    const strB = canonicalize(payloadB);
    expect(strA).toBe(strB);
    expect(computeCanonicalSha256(payloadA)).toBe(computeCanonicalSha256(payloadB));
  });

  it("should generate completely different SHA-256 hashes if a single value changes", () => {
    const original = { amount: "25.00", currency: "BRL" };
    const modified = { amount: "25.01", currency: "BRL" };
    expect(computeCanonicalSha256(original)).not.toBe(computeCanonicalSha256(modified));
  });
});
