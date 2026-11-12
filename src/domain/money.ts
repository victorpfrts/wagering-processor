import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors.ts';

export interface MoneyProps {
  /** String decimal com escala fixa de 2 casas, ex.: "25.00". */
  amount: string;
  /** ISO-4217. */
  currency: string;
}

/**
 * Cópia isolada do Decimal: precisão folgada para que somas nunca sejam
 * arredondadas e nenhuma configuração global de terceiros nos afete.
 */
const Dec = Decimal.clone({ precision: 60, toExpNeg: -30, toExpPos: 60 });

const SCALE = 2;
/** Até 17 dígitos inteiros + 2 decimais: cabe em NUMERIC(19,2). */
const INPUT_PATTERN = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_ABSOLUTE = new Dec('1e17');

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (!value.isFinite() || value.abs().greaterThanOrEqualTo(MAX_ABSOLUTE)) {
      throw new InvalidMoneyError('Amount out of the supported range');
    }
  }

  /**
   * Contrato de entrada: aceita apenas string decimal não negativa com até
   * 2 casas e a normaliza para 2 casas. Nada é arredondado: o que não cabe
   * é rejeitado.
   */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props as { amount: unknown; currency: unknown };
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be an ISO-4217 code');
    }
    if (typeof amount !== 'string' || !INPUT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'Amount must be a non-negative decimal string with at most 2 decimal places',
      );
    }
    return new Money(new Dec(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
