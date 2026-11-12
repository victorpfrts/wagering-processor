import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors.ts';
import { Money } from '../../src/domain/money.ts';
import { brl, usd } from './helpers.ts';

describe('Money.from', () => {
  test.each([
    ['25.00', '25.00'],
    ['25.5', '25.50'],
    ['25', '25.00'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['99999999999999999.99', '99999999999999999.99'],
  ])('aceita %p e serializa com 2 casas', (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each([
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E-2',
    '',
    ' ',
    '25.001',
    '-1.00',
    '+1.00',
    '1,00',
    '.50',
    '1.',
    '01.00',
    ' 1.00',
    '0x10',
    '100000000000000000.00',
  ])('rejeita %p', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test.each([25, 25.5, Number.NaN, null, undefined, {}])('rejeita valor não-string %p', (input) => {
    expect(() => Money.from({ amount: input as never, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(['brl', 'BR', 'BRLL', '', 'B1L'])('rejeita moeda %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money aritmética', () => {
  test('soma e subtração são exatas (0.10 + 0.20 = 0.30)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('0.30').subtract(brl('0.10')).toJSON().amount).toBe('0.20');
  });

  test('não perde precisão acima de 2^53', () => {
    const big = brl('90071992547409.93');
    expect(big.add(brl('0.01')).toJSON().amount).toBe('90071992547409.94');
    expect(brl('99999999999999999.98').add(brl('0.01')).toJSON().amount).toBe(
      '99999999999999999.99',
    );
  });

  test('estouro do intervalo suportado é erro, não arredondamento', () => {
    expect(() => brl('99999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });

  test('é imutável: operações devolvem nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b).not.toBe(a);
  });

  test('subtração pode ficar negativa internamente; negate inverte o sinal', () => {
    const negative = brl('10.00').subtract(brl('25.00'));
    expect(negative.isNegative()).toBe(true);
    expect(negative.toJSON().amount).toBe('-15.00');
    expect(negative.negate().equals(brl('15.00'))).toBe(true);
  });

  test('predicados', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.0').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').toString()).toBe('1.00 BRL');
  });
});

describe('Money conflito de moeda', () => {
  test('add, subtract e isLessThan entre moedas diferentes lançam erro de domínio', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('equals entre moedas diferentes é false, sem lançar', () => {
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });
});
