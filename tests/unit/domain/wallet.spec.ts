import { describe, expect, it } from "bun:test";
import { Wallet } from "../../../src/domain/entities/wallet";
import {
  WagerTransaction,
  TransactionType,
  TransactionStatus,
  LedgerDirection,
} from "../../../src/domain/entities/wager-transaction";
import { Money } from "../../../src/domain/value-objects/money";
describe("Wallet Aggregate Root", () => {
  it("should debit balance and increment version when balance is sufficient", () => {
    const wallet = new Wallet("w-1", "p-1", "BRL", Money.fromDecimal("100.00", "BRL"), 1);
    const result = wallet.debit(Money.fromDecimal("40.00", "BRL"));
    expect(result.balanceBefore.toString()).toBe("100.00");
    expect(result.balanceAfter.toString()).toBe("60.00");
    expect(result.walletVersion).toBe(2);
    expect(wallet.getBalance().toString()).toBe("60.00");
  });
  it("should throw InsufficientBalanceException when attempting to debit more than balance", () => {
    const wallet = new Wallet("w-1", "p-1", "BRL", Money.fromDecimal("50.00", "BRL"), 1);
    expect(() => {
      wallet.debit(Money.fromDecimal("80.00", "BRL"));
    }).toThrow("InsufficientBalanceException");
    expect(wallet.getBalance().toString()).toBe("50.00");
    expect(wallet.getVersion()).toBe(1);
  });
  it("should credit balance and record correct before and after amounts", () => {
    const wallet = new Wallet("w-1", "p-1", "BRL", Money.fromDecimal("10.00", "BRL"), 1);
    const result = wallet.credit(Money.fromDecimal("50.00", "BRL"));
    expect(result.balanceBefore.toString()).toBe("10.00");
    expect(result.balanceAfter.toString()).toBe("60.00");
    expect(result.walletVersion).toBe(2);
  });
});
describe("WagerTransaction State Machine", () => {
  it("should correctly invert ledger direction for ROLLBACK on a BET", () => {
    const betTx = new WagerTransaction(
      "b-1",
      "r-1",
      "w-1",
      TransactionType.BET,
      Money.fromDecimal("10.00", "BRL"),
    );
    const rollbackTx = new WagerTransaction(
      "rb-1",
      "r-1",
      "w-1",
      TransactionType.ROLLBACK,
      Money.fromDecimal("10.00", "BRL"),
    );
    expect(rollbackTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.CREDIT);
  });
  it("should prevent any transition from terminal states", () => {
    const wonTx = new WagerTransaction(
      "w-1",
      "r-1",
      "w-1",
      TransactionType.WIN,
      Money.fromDecimal("100.00", "BRL"),
      TransactionStatus.WON,
    );
    expect(() => {
      wonTx.transitionTo(TransactionStatus.REFUNDED);
    }).toThrow("IllegalStateTransitionException");
  });
});
