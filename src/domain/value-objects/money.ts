import Decimal from "decimal.js";
export class Money {
  private readonly amount: Decimal;
  private readonly currency: string;
  private constructor(amount: Decimal, currency: string) {
    this.amount = amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    this.currency = currency.toUpperCase();
    Object.freeze(this);
    // Imutabilidade profunda absoluta
  }
  public static fromDecimal(amount: string | number | Decimal, currency: string): Money {
    if (amount === null || amount === undefined) {
      throw new Error("Money amount cannot be null or undefined");
    }
    const decimalValue = new Decimal(amount);
    if (decimalValue.isNaN()) {
      throw new Error("Money amount must be a valid numeric representation");
    }
    return new Money(decimalValue, currency);
  }
  public static zero(currency: string): Money {
    return new Money(new Decimal(0), currency);
  }
  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }
  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }
  public lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.lessThan(other.amount);
  }
  public greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.greaterThan(other.amount);
  }
  public isNegative(): boolean {
    return this.amount.isNegative();
  }
  public isZero(): boolean {
    return this.amount.isZero();
  }
  public equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }
  public toString(): string {
    return this.amount.toFixed(2);
  }
  public getCurrency(): string {
    return this.currency;
  }
  public toDecimal(): Decimal {
    return new Decimal(this.amount);
  }
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `CurrencyMismatchException: Cannot operate between '${this.currency}' and
'${other.currency}'`,
      );
    }
  }
}
