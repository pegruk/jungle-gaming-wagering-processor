import { Money } from "../value-objects/money";

export class InsufficientBalanceError extends Error {
  public readonly code: "INSUFFICIENT_FUNDS" | "REVERSAL_INSUFFICIENT_FUNDS";

  public constructor(isReversal: boolean) {
    const code = isReversal ? "REVERSAL_INSUFFICIENT_FUNDS" : "INSUFFICIENT_FUNDS";
    super(`InsufficientBalanceException: ${code}`);
    this.name = "InsufficientBalanceError";
    this.code = code;
  }
}

export interface BalanceChangeResult {
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private readonly id: string;
  private readonly playerId: string;
  private readonly currency: string;
  private balance: Money;
  private version: number;
  private readonly createdAt: Date;
  private updatedAt: Date;
  private constructor(
    id: string,
    playerId: string,
    currency: string,
    initialBalance: Money,
    version = 1,
    createdAt = new Date(),
    updatedAt = new Date(),
  ) {
    this.id = id;
    this.playerId = playerId;
    this.currency = currency.toUpperCase();
    this.balance = initialBalance;
    this.version = version;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  public static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (!props.id || !props.playerId || props.initialBalance.isNegative()) {
      throw new Error("Invalid wallet opening state");
    }
    return new Wallet(props.id, props.playerId, props.initialBalance.getCurrency(), props.initialBalance);
  }

  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  public debit(amount: Money, isReversal = false): BalanceChangeResult {
    if (amount.isNegative() || amount.isZero()) {
      throw new Error("Debit amount must be strictly positive");
    }
    if (this.balance.lessThan(amount)) {
      throw new InsufficientBalanceError(isReversal);
    }
    const balanceBefore = this.balance;
    this.balance = this.balance.subtract(amount);
    this.version += 1;
    this.updatedAt = new Date();
    return {
      balanceBefore,
      balanceAfter: this.balance,
      walletVersion: this.version,
    };
  }

  public credit(amount: Money): BalanceChangeResult {
    if (amount.isNegative() || amount.isZero()) {
      throw new Error("Credit amount must be strictly positive");
    }
    const balanceBefore = this.balance;
    this.balance = this.balance.add(amount);
    this.version += 1;
    this.updatedAt = new Date();
    return {
      balanceBefore,
      balanceAfter: this.balance,
      walletVersion: this.version,
    };
  }

  public getBalance(): Money {
    return this.balance;
  }

  public getVersion(): number {
    return this.version;
  }

  public getId(): string {
    return this.id;
  }

  public getCurrency(): string {
    return this.currency;
  }

  public toState(): WalletState {
    return { id: this.id, playerId: this.playerId, currency: this.currency,
      balance: this.balance, version: this.version,
      createdAt: new Date(this.createdAt), updatedAt: new Date(this.updatedAt) };
  }
}
