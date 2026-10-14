import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/value-objects/money";

describe("Money Value Object", () => {
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

  it("should round decimal places using ROUND_HALF_UP (banker's standard)", () => {
    const money = Money.fromDecimal("10.555", "BRL");
    expect(money.toString()).toBe("10.56");
  });

  it("should correctly compare amounts with lessThan and greaterThan", () => {
    const small = Money.fromDecimal("10.00", "BRL");
    const big = Money.fromDecimal("100.00", "BRL");
    expect(small.lessThan(big)).toBe(true);
    expect(big.greaterThan(small)).toBe(true);
    expect(small.equals(Money.fromDecimal("10.00", "BRL"))).toBe(true);
  });
});
