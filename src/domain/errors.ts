export type FailureCode =
  | "INSUFFICIENT_FUNDS" | "REVERSAL_INSUFFICIENT_FUNDS" | "PLAYER_MISMATCH"
  | "CURRENCY_MISMATCH" | "REFERENCE_MISMATCH" | "REFERENCE_KIND_INVALID"
  | "REFERENCE_NOT_PROCESSED" | "REFERENCE_EXPIRED" | "REVERSAL_AMOUNT_MISMATCH"
  | "ALREADY_REVERSED" | "BALANCE_LIMIT_EXCEEDED" | "PERMANENT_INFRASTRUCTURE_FAILURE";

export class DomainError extends Error {
  constructor(public readonly code: FailureCode) {
    super(code);
    this.name = "DomainError";
  }
}
