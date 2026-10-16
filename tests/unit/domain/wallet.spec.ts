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
    const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: Money.fromDecimal("100.00", "BRL") });
    const result = wallet.debit(Money.fromDecimal("40.00", "BRL"));
    expect(result.balanceBefore.toString()).toBe("100.00");
    expect(result.balanceAfter.toString()).toBe("60.00");
    expect(result.walletVersion).toBe(2);
    expect(wallet.getBalance().toString()).toBe("60.00");
  });

  it("should throw InsufficientBalanceException when attempting to debit more than balance", () => {
    const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: Money.fromDecimal("50.00", "BRL") });
    expect(() => {
      wallet.debit(Money.fromDecimal("80.00", "BRL"));
    }).toThrow("InsufficientBalanceException");
    expect(wallet.getBalance().toString()).toBe("50.00");
    expect(wallet.getVersion()).toBe(1);
  });

  it("should credit balance and record correct before and after amounts", () => {
    const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: Money.fromDecimal("10.00", "BRL") });
    const result = wallet.credit(Money.fromDecimal("50.00", "BRL"));
    expect(result.balanceBefore.toString()).toBe("10.00");
    expect(result.balanceAfter.toString()).toBe("60.00");
    expect(result.walletVersion).toBe(2);
  });

  it("should reject an unfunded reversal with a distinct code and preserve state", () => {
    const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: Money.fromDecimal("10.00", "BRL") });
    expect(() => wallet.debit(Money.fromDecimal("20.00", "BRL"), true)).toThrow("REVERSAL_INSUFFICIENT_FUNDS");
    expect(wallet.getBalance().toString()).toBe("10.00");
    expect(wallet.getVersion()).toBe(1);
  });

  it("should preserve balance and version after a currency conflict", () => {
    const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: Money.fromDecimal("10.00", "BRL") });
    expect(() => wallet.credit(Money.fromDecimal("5.00", "USD"))).toThrow("CurrencyMismatchException");
    expect(() => wallet.debit(Money.fromDecimal("5.00", "USD"))).toThrow("CurrencyMismatchException");
    expect(wallet.getBalance().toString()).toBe("10.00");
    expect(wallet.getVersion()).toBe(1);
  });
});

describe("WagerTransaction State Machine", () => {
  const make = (kind: TransactionType, referenceExternalTransactionId?: string) => WagerTransaction.create({
    id: kind, providerId: "provider", externalTransactionId: kind, playerId: "player", walletId: "wallet",
    roundId: "round", gameId: "game", kind, money: { amount: "10.00", currency: "BRL" },
    idempotencyKey: kind, payloadHash: "hash", referenceExternalTransactionId,
  });

  it("should correctly invert ledger direction for ROLLBACK on a BET", () => {
    const betTx = make(TransactionType.BET);
    betTx.markProcessed(undefined, new Date());
    const rollbackTx = make(TransactionType.ROLLBACK, "BET");
    expect(rollbackTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.CREDIT);
  });

  it("should prevent any transition from terminal states", () => {
    const wonTx = make(TransactionType.WIN);
    wonTx.markProcessed(undefined, new Date());
    expect(() => {
      wonTx.reject("REFERENCE_MISMATCH");
    }).toThrow("InvalidTransactionState");
  });

  it.each([TransactionStatus.PROCESSED, TransactionStatus.REJECTED, TransactionStatus.FAILED])("should keep terminal state %s immutable", (status) => {
    const transaction = WagerTransaction.rehydrate({ ...make(TransactionType.BET).toState(), status });
    expect(() => transaction.markPendingReference()).toThrow();
    expect(() => transaction.markProcessed(undefined, new Date())).toThrow();
    expect(() => transaction.reject("REFERENCE_MISMATCH")).toThrow();
    expect(() => transaction.fail("PERMANENT_INFRASTRUCTURE_FAILURE")).toThrow();
  });

  it("requires references for reversals and rejects rollback of LOSS", () => {
    expect(() => make(TransactionType.REFUND)).toThrow();
    expect(() => make(TransactionType.ROLLBACK)).toThrow();
    const loss = make(TransactionType.LOSS);
    loss.markProcessed(undefined, new Date());
    expect(() => make(TransactionType.ROLLBACK, "LOSS").validateReference(loss)).toThrow("REFERENCE_KIND_INVALID");
  });
});
