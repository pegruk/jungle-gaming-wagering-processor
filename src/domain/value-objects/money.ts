import Decimal from "decimal.js";

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Isolate financial precision from changes to Decimal's global configuration.
const FinancialDecimal = Decimal.clone({ precision: 40 });
const MAX_AMOUNT = "99999999999999.99"; // PostgreSQL NUMERIC(16, 2).

export class Money {
  readonly #amount: Decimal;
  private readonly currency: string;

  private constructor(amount: Decimal, currency: string) {
    if (!amount.isFinite() || amount.abs().greaterThan(MAX_AMOUNT) || amount.decimalPlaces() > 2) {
      throw new Error("Money amount exceeds NUMERIC(16, 2) range or scale");
    }
    if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
      throw new Error("Money currency must be a three-letter currency code");
    }
    this.#amount = amount;
    this.currency = currency.toUpperCase();
    Object.freeze(this);
  }

  public static from(props: MoneyProps): Money {
    return Money.fromDecimal(props.amount, props.currency);
  }

  public static fromDecimal(amount: string, currency: string): Money {
    if (typeof amount !== "string" || !/^(0|[1-9]\d{0,13})\.\d{2}$/.test(amount)) {
      throw new Error("Money amount must be a non-negative decimal string with exactly two places");
    }
    return new Money(new FinancialDecimal(amount), currency);
  }

  public static zero(currency: string): Money {
    return new Money(new FinancialDecimal("0.00"), currency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#amount.plus(other.#amount), this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#amount.minus(other.#amount), this.currency);
  }

  public negate(): Money {
    return new Money(this.#amount.negated(), this.currency);
  }

  public lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#amount.lessThan(other.#amount);
  }

  public isLessThan(other: Money): boolean {
    return this.lessThan(other);
  }

  public greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#amount.greaterThan(other.#amount);
  }

  public isNegative(): boolean {
    return this.#amount.isNegative() && !this.#amount.isZero();
  }

  public isPositive(): boolean {
    return this.#amount.greaterThan("0.00");
  }

  public isZero(): boolean {
    return this.#amount.isZero();
  }

  public equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#amount.equals(other.#amount);
  }

  public toString(): string {
    return this.#amount.toFixed(2);
  }

  public toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  public getCurrency(): string {
    return this.currency;
  }

  public toDecimal(): Decimal {
    return new FinancialDecimal(this.#amount);
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
