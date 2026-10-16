import { Money } from "../value-objects/money";
import { LedgerDirection } from "./wager-transaction";

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(private readonly state: LedgerEntryState) { Object.freeze(this); }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry({ ...state });
    if (!state.money.isPositive() || state.balanceBefore.isNegative() || state.balanceAfter.isNegative() || !entry.isBalanced()) {
      throw new Error("Invalid ledger arithmetic");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry({ ...state }); }

  isBalanced(): boolean {
    const { balanceBefore, balanceAfter, money, direction } = this.state;
    return (direction === LedgerDirection.CREDIT ? balanceBefore.add(money) : balanceBefore.subtract(money)).equals(balanceAfter);
  }

  toState(): LedgerEntryState { return { ...this.state, createdAt: new Date(this.state.createdAt) }; }
}
