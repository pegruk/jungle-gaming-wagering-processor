import { Money } from "../value-objects/money";
export interface BalanceChangeResult {
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
}
export class Wallet {
  private readonly id: string;
  private readonly playerId: string;
  private readonly currency: string;
  private balance: Money;
  private version: number;
  private readonly createdAt: Date;
  private updatedAt: Date;
  public constructor(
    id: string,
    playerId: string,
    currency: string,
    initialBalance: Money,
    version = 1,
    createdAt = new Date(),
    updatedAt = new Date(),
  ) {
    if (!id || !playerId || !currency) {
      throw new Error("Wallet must have id, playerId and currency");
    }
    if (initialBalance.getCurrency() !== currency.toUpperCase()) {
      throw new Error("Initial balance currency must match wallet currency");
    }
    if (initialBalance.isNegative()) {
      throw new Error("Wallet balance cannot be initialized as negative");
    }
    this.id = id;
    this.playerId = playerId;
    this.currency = currency.toUpperCase();
    this.balance = initialBalance;
    this.version = version;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
  public debit(amount: Money, isReversal = false): BalanceChangeResult {
    if (amount.isNegative() || amount.isZero()) {
      throw new Error("Debit amount must be strictly positive");
    } // Invariante de ouro: saldo nunca pode ficar negativo, exceto em estornos técnicos
    if (this.balance.lessThan(amount) && !isReversal) {
      throw new Error(
        `InsufficientBalanceException: Current balance ${this.balance.toString()} ${this.currency}
is insufficient for debit of ${amount.toString()} ${this.currency}`,
      );
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
}
