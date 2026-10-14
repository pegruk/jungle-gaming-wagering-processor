import { Money } from "../value-objects/money";
export enum TransactionType {
  BET = "BET",
  WIN = "WIN",
  LOSS = "LOSS",
  REFUND = "REFUND",
  ROLLBACK = "ROLLBACK",
}
export enum TransactionStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  WON = "WON",
  LOST = "LOST",
  REFUNDED = "REFUNDED",
  ROLLED_BACK = "ROLLED_BACK",
}
export enum LedgerDirection {
  DEBIT = "DEBIT",
  CREDIT = "CREDIT",
}
export class WagerTransaction {
  private readonly id: string;
  private readonly roundId: string;
  private readonly walletId: string;
  private readonly type: TransactionType;
  private readonly amount: Money;
  private status: TransactionStatus;
  private readonly referenceTransactionId?: string;
  public constructor(
    id: string,
    roundId: string,
    walletId: string,
    type: TransactionType,
    amount: Money,
    status = TransactionStatus.PENDING,
    referenceTransactionId?: string,
  ) {
    this.id = id;
    this.roundId = roundId;
    this.walletId = walletId;
    this.type = type;
    this.amount = amount;
    this.status = status;
    this.referenceTransactionId = referenceTransactionId;
  }
  public isTerminal(): boolean {
    return [
      TransactionStatus.WON,
      TransactionStatus.LOST,
      TransactionStatus.REFUNDED,
      TransactionStatus.ROLLED_BACK,
    ].includes(this.status);
  }
  public transitionTo(newStatus: TransactionStatus): void {
    if (this.isTerminal()) {
      throw new Error(
        `IllegalStateTransitionException: Cannot transition transaction '${this.id}' from terminal
state '${this.status}' to '${newStatus}'`,
      );
    }
    this.status = newStatus;
  }
  public ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.type === TransactionType.BET) {
      return LedgerDirection.DEBIT;
    }
    if (this.type === TransactionType.WIN || this.type === TransactionType.REFUND) {
      return LedgerDirection.CREDIT;
    }
    if (this.type === TransactionType.ROLLBACK) {
      if (!reference) {
        throw new Error("Rollback requires reference transaction to determine ledger direction");
      }
      // Inversão contábil elegante: se desfaz uma aposta (BET), credita. Se desfaz um ganho (WIN), debita!
      return reference.type === TransactionType.BET
        ? LedgerDirection.CREDIT
        : LedgerDirection.DEBIT;
    }
    throw new Error(`Transaction type ${this.type} does not affect financial ledger`);
  }
  public getStatus(): TransactionStatus {
    return this.status;
  }
  public getId(): string {
    return this.id;
  }
}
