const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;

export type AmountParseError =
  | { code: 'AMOUNT_SYNTAX'; message: string }
  | { code: 'AMOUNT_PRECISION'; message: string }
  | { code: 'AMOUNT_NOT_POSITIVE'; message: string }
  | { code: 'AMOUNT_OVERFLOW'; message: string };

export type AmountParseResult =
  | { ok: true; baseUnits: bigint }
  | { ok: false; error: AmountParseError };

/**
 * Converts a human decimal string into integer base units without ever passing
 * through floating point. Rejects (never rounds) amounts that carry more
 * fractional digits than the asset supports.
 */
export function parseDecimalAmount(input: string, decimals: number, max: bigint): AmountParseResult {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`unsupported decimals: ${decimals}`);
  }
  const trimmed = input.trim();
  const match = DECIMAL_PATTERN.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: {
        code: 'AMOUNT_SYNTAX',
        message: `"${input}" is not a plain decimal amount (digits with an optional "." and no signs, separators or exponents)`,
      },
    };
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    return {
      ok: false,
      error: {
        code: 'AMOUNT_PRECISION',
        message: `"${input}" has ${fraction.length} fractional digits but the asset supports ${decimals}`,
      },
    };
  }
  const baseUnits = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (baseUnits === 0n) {
    return { ok: false, error: { code: 'AMOUNT_NOT_POSITIVE', message: 'amount must be greater than zero' } };
  }
  if (baseUnits > max) {
    return { ok: false, error: { code: 'AMOUNT_OVERFLOW', message: `"${input}" exceeds the asset's representable range` } };
  }
  return { ok: true, baseUnits };
}

export function formatBaseUnits(baseUnits: bigint | string, decimals: number): string {
  const value = typeof baseUnits === 'string' ? BigInt(baseUnits) : baseUnits;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
