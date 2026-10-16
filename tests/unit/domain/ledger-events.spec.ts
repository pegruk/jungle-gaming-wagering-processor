import { describe, expect, it } from "bun:test";
import { Money } from "../../../src/domain/value-objects/money";
import { WalletLedgerEntry } from "../../../src/domain/entities/wallet-ledger-entry";
import { LedgerDirection } from "../../../src/domain/entities/wager-transaction";
import { WalletBalanceChanged } from "../../../src/domain/events/integration-event";

describe("Ledger arithmetic and event contracts", () => {
  const state = {
    id: "entry",
    walletId: "wallet",
    transactionId: "tx",
    direction: LedgerDirection.CREDIT,
    money: Money.fromDecimal("10.00", "BRL"),
    balanceBefore: Money.zero("BRL"),
    balanceAfter: Money.fromDecimal("10.00", "BRL"),
    walletVersion: 1,
    createdAt: new Date(),
  };

  it("creates only balanced entries and preserves them when a returned snapshot is changed", () => {
    const entry = WalletLedgerEntry.create(state);
    expect(entry.isBalanced()).toBe(true);
    const copy = entry.toState();
    copy.balanceAfter = Money.zero("BRL");
    expect(entry.isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create(copy)).toThrow("Invalid ledger arithmetic");
  });

  it("serializes a versioned event with correlation and decimal strings", () => {
    const event = WalletBalanceChanged.from({
      eventId: "event",
      aggregateId: "wallet",
      correlationId: "request",
      occurredAt: new Date("2026-10-15T00:00:00Z"),
      data: { money: state.money.toJSON() },
    });
    expect(event.toJSON()).toMatchObject({
      eventType: "WalletBalanceChanged",
      version: 1,
      occurredAt: "2026-10-15T00:00:00.000Z",
      data: { money: { amount: "10.00", currency: "BRL" } },
    });
  });
});
