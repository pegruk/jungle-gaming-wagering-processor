import { DomainError, type FailureCode } from "../errors";
import { Money, type MoneyProps } from "../value-objects/money";

export enum TransactionType {
  OPENING = "OPENING", BET = "BET", WIN = "WIN", LOSS = "LOSS", REFUND = "REFUND", ROLLBACK = "ROLLBACK",
}

export enum TransactionStatus {
  PENDING = "PENDING", PENDING_REFERENCE = "PENDING_REFERENCE", PROCESSED = "PROCESSED",
  REJECTED = "REJECTED", FAILED = "FAILED",
}

export enum LedgerDirection { DEBIT = "DEBIT", CREDIT = "CREDIT" }

export interface WagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: TransactionType;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerState extends WagerRequest {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  status: TransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  createdAt: Date;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(private readonly state: WagerState, public readonly money: Money) {}

  static create(props: Omit<WagerState, "status" | "createdAt" | "processedAt" | "failureCode" | "referenceTransactionId">): WagerTransaction {
    const money = Money.from(props.money);
    if ((props.kind === TransactionType.REFUND || props.kind === TransactionType.ROLLBACK) && !props.referenceExternalTransactionId) {
      throw new Error("Reversals require referenceExternalTransactionId");
    }
    if (props.kind === TransactionType.BET && !money.isPositive()) throw new Error("BET money must be strictly positive");
    return new WagerTransaction({ ...props, money: money.toJSON(), status: TransactionStatus.PENDING, createdAt: new Date() }, money);
  }

  static rehydrate(state: WagerState): WagerTransaction { return new WagerTransaction({ ...state }, Money.from(state.money)); }
  get status(): TransactionStatus { return this.state.status; }
  get id(): string { return this.state.id; }
  get kind(): TransactionType { return this.state.kind; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  isTerminal(): boolean { return [TransactionStatus.PROCESSED, TransactionStatus.REJECTED, TransactionStatus.FAILED].includes(this.status); }

  private assertMutable(): void {
    if (this.isTerminal()) throw new Error("InvalidTransactionState: terminal transaction");
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    this.state.status = TransactionStatus.PROCESSED;
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.processedAt = new Date(at);
  }

  markPendingReference(): void { this.assertMutable(); this.state.status = TransactionStatus.PENDING_REFERENCE; }

  resume(): void { this.assertMutable(); this.state.status = TransactionStatus.PENDING; }

  reject(code: FailureCode): void {
    this.assertMutable(); this.state.status = TransactionStatus.REJECTED;
    this.state.failureCode = code; this.state.processedAt = new Date();
  }

  fail(code: FailureCode): void {
    this.assertMutable(); this.state.status = TransactionStatus.FAILED;
    this.state.failureCode = code; this.state.processedAt = new Date();
  }

  affectsBalance(): boolean { return this.kind !== TransactionType.LOSS && !this.money.isZero(); }
  requiresReference(): boolean { return [TransactionType.REFUND, TransactionType.ROLLBACK].includes(this.kind); }
  matchesPayload(hash: string): boolean { return this.state.payloadHash === hash; }

  validateReference(reference: WagerTransaction): void {
    const a = this.state;
    const b = reference.state;
    if (a.id === b.id || a.providerId !== b.providerId || a.playerId !== b.playerId || a.walletId !== b.walletId ||
        a.money.currency !== b.money.currency || a.roundId !== b.roundId) throw new DomainError("REFERENCE_MISMATCH");
    const valid = this.kind === TransactionType.ROLLBACK ? [TransactionType.BET, TransactionType.WIN, TransactionType.REFUND] : [TransactionType.BET];
    if (!valid.includes(reference.kind)) throw new DomainError("REFERENCE_KIND_INVALID");
    if (reference.status !== TransactionStatus.PROCESSED) throw new DomainError("REFERENCE_NOT_PROCESSED");
    if (this.requiresReference() && !this.money.equals(reference.money)) throw new DomainError("REVERSAL_AMOUNT_MISMATCH");
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === TransactionType.LOSS) throw new Error("LOSS has no ledger direction");
    if (this.kind === TransactionType.BET) return LedgerDirection.DEBIT;
    if (this.kind === TransactionType.ROLLBACK) {
      if (!reference) throw new Error("ROLLBACK requires a reference");
      this.validateReference(reference);
      return reference.kind === TransactionType.BET ? LedgerDirection.CREDIT : LedgerDirection.DEBIT;
    }
    return LedgerDirection.CREDIT;
  }

  toState(): WagerState { return { ...this.state, money: this.money.toJSON(), createdAt: new Date(this.state.createdAt) }; }
  getStatus(): TransactionStatus { return this.status; }
  getId(): string { return this.id; }
}
