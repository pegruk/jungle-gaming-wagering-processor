import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/value-objects/money";
import Decimal from "decimal.js";

describe("Money Value Object", () => {
  it("rejects unknown currency codes and preserves exact arithmetic when Decimal globals change", () => {
    expect(() => Money.fromDecimal("1.00", "ZZZ")).toThrow("ISO-4217");
    const original = Decimal.precision;
    try {
      Decimal.set({ precision: 2 });
      expect(Money.fromDecimal("10.00", "BRL").subtract(Money.fromDecimal("0.01", "BRL")).toString()).toBe("9.99");
    } finally { Decimal.set({ precision: original }); }
  });
  it("should calculate 0.10 + 0.20 === 0.30 exactly without IEEE-754 float flaws", () => {
    const a = Money.fromDecimal("0.10", "BRL");
    const b = Money.fromDecimal("0.20", "BRL");
    const result = a.add(b);
    expect(result.toString()).toBe("0.30");
  });

  it("should reject operations between different currencies", () => {
    const brl = Money.fromDecimal("100.00", "BRL");
    const usd = Money.fromDecimal("50.00", "USD");
    expect(() => brl.add(usd)).toThrow("CurrencyMismatchException");
    expect(() => brl.subtract(usd)).toThrow("CurrencyMismatchException");
  });

  it("should guarantee immutability with Object.freeze", () => {
    const money = Money.fromDecimal("50.00", "BRL");
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as Record<string, unknown>).amount = "999";
    }).toThrow();
  });

  it.each([
    "10.555",
    "1e3",
    "Infinity",
    "-Infinity",
    "NaN",
    "",
    " ",
    "-1.00",
    "1",
    "1.0",
    "01.00",
    "+1.00",
  ])("should reject invalid input %j instead of rounding or coercing it", (input) =>
    expect(() => Money.fromDecimal(input, "BRL")).toThrow(),
  );

  it("should reject number inputs even from untyped callers", () => {
    expect(() => Money.fromDecimal(0.1 as unknown as string, "BRL")).toThrow();
  });

  it("should serialize exactly the public money contract", () => {
    expect(JSON.parse(JSON.stringify(Money.fromDecimal("25.00", "BRL")))).toEqual({
      amount: "25.00",
      currency: "BRL",
    });
  });

  it("should preserve cents at the database boundary and reject overflow", () => {
    const maximum = Money.fromDecimal("99999999999999.99", "BRL");
    expect(maximum.subtract(Money.fromDecimal("0.01", "BRL")).toString()).toBe("99999999999999.98");
    expect(() => maximum.add(Money.fromDecimal("0.01", "BRL"))).toThrow();
    expect(() => Money.fromDecimal("100000000000000.00", "BRL")).toThrow();
  });

  it("should retain signed results internally without accepting negative input", () => {
    const difference = Money.zero("BRL").subtract(Money.fromDecimal("0.01", "BRL"));
    expect(difference.toString()).toBe("-0.01");
    expect(difference.isNegative()).toBe(true);
  });

  it("should correctly compare amounts with lessThan and greaterThan", () => {
    const small = Money.fromDecimal("10.00", "BRL");
    const big = Money.fromDecimal("100.00", "BRL");
    expect(small.lessThan(big)).toBe(true);
    expect(big.greaterThan(small)).toBe(true);
    expect(small.equals(Money.fromDecimal("10.00", "BRL"))).toBe(true);
  });
});
