import { describe, expect, it } from 'vitest';

import { UINT128_MAX, formatBaseUnits, parseDecimalAmount } from '../src/amount.js';
import { canonicalJson, digestToBytes32, sha256Digest } from '../src/canonical.js';
import { CsvSyntaxError, parseCsv, sanitizeCsvCell, serializeCsv } from '../src/csv.js';
import { checkEvmAddress, checkNativeAddress } from '../src/address.js';
import { NATIVE_ALICE, NATIVE_ALICE_OTHER_PREFIX, SS58_PREFIX } from './fixtures.js';

describe('parseDecimalAmount', () => {
  it.each([
    ['1', 0, 1n],
    ['50', 14, 5_000_000_000_000_000n],
    ['0.00000000000001', 14, 1n],
    ['100.25', 6, 100_250_000n],
    ['007', 0, null],
  ])('%s @ %i decimals', (input, decimals, expected) => {
    const result = parseDecimalAmount(input, decimals, UINT128_MAX);
    if (expected === null) expect(result.ok).toBe(false);
    else expect(result).toEqual({ ok: true, baseUnits: expected });
  });

  it.each([
    ['1.0000001', 6, 'AMOUNT_PRECISION'],
    ['0', 6, 'AMOUNT_NOT_POSITIVE'],
    ['0.000', 6, 'AMOUNT_NOT_POSITIVE'],
    ['-1', 6, 'AMOUNT_SYNTAX'],
    ['1e3', 6, 'AMOUNT_SYNTAX'],
    ['1,000', 6, 'AMOUNT_SYNTAX'],
    ['.5', 6, 'AMOUNT_SYNTAX'],
    ['5.', 6, 'AMOUNT_SYNTAX'],
    ['', 6, 'AMOUNT_SYNTAX'],
  ])('rejects %s', (input, decimals, code) => {
    const result = parseDecimalAmount(input, decimals, UINT128_MAX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('rejects values above the representable maximum', () => {
    const result = parseDecimalAmount((UINT128_MAX + 1n).toString(), 0, UINT128_MAX);
    expect(result.ok ? null : result.error.code).toBe('AMOUNT_OVERFLOW');
  });

  it('round-trips through formatBaseUnits without precision loss', () => {
    const big = '123456789012345678901234567890.12345678901234';
    const result = parseDecimalAmount(big, 14, (1n << 256n) - 1n);
    expect(result.ok && formatBaseUnits(result.baseUnits, 14)).toBe(big);
    expect(formatBaseUnits(100_000_000n, 6)).toBe('100');
    expect(formatBaseUnits('1', 14)).toBe('0.00000000000001');
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const table = parseCsv('﻿a,b\r\n"x, ""y""","line1\nline2"\r\n\r\n');
    expect(table.headers).toEqual(['a', 'b']);
    expect(table.records).toEqual([{ line: 2, values: ['x, "y"', 'line1\nline2'] }]);
  });

  it('rejects ragged rows and stray quotes', () => {
    expect(() => parseCsv('a,b\n1')).toThrow(CsvSyntaxError);
    expect(() => parseCsv('a,b\n1,x"y')).toThrow(/quote inside/);
    expect(() => parseCsv('a,b\n1,"open')).toThrow(/unterminated/);
    expect(() => parseCsv('a,b\n1,"x"y')).toThrow(/after closing quote/);
  });

  it('neutralises formula-like cells on export', () => {
    expect(sanitizeCsvCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(sanitizeCsvCell('+1')).toBe(`'+1`);
    expect(sanitizeCsvCell('@SUM')).toBe(`'@SUM`);
    expect(sanitizeCsvCell('plain')).toBe('plain');
    expect(serializeCsv(['h'], [['=1+1'], ['a,b'], ['say "hi"']])).toBe(`h\r\n'=1+1\r\n"a,b"\r\n"say ""hi"""\r\n`);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 'x' }], c: undefined } })).toBe('{"a":{"d":[2,{"y":"x","z":1}]},"b":1}');
  });

  it('refuses non-integer numbers', () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(TypeError);
  });

  it('maps a sha256 digest to bytes32', () => {
    const digest = sha256Digest('abc');
    expect(digest).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(digestToBytes32(digest)).toBe('0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('addresses', () => {
  it('accepts lowercase EVM addresses and checksums them', () => {
    const result = checkEvmAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
    expect(result).toEqual({ ok: true, canonical: '0x5FbDB2315678afecb367f032d93F642f64180aa3' });
  });

  it('rejects a bad EIP-55 checksum and the zero address', () => {
    expect(checkEvmAddress('0x5FbDB2315678afecb367f032d93F642f64180aA3').ok).toBe(false);
    expect(checkEvmAddress('0x0000000000000000000000000000000000000000').ok).toBe(false);
  });

  it('re-encodes SS58 addresses from another prefix with a warning', () => {
    const result = checkNativeAddress(NATIVE_ALICE_OTHER_PREFIX, SS58_PREFIX);
    expect(result.ok && result.canonical).toBe(NATIVE_ALICE);
    expect(result.ok && result.warning).toMatch(/re-encoded/);
  });

  it('rejects hex and garbage for native destinations', () => {
    expect(checkNativeAddress('0x2222222222222222222222222222222222222222', SS58_PREFIX).ok).toBe(false);
    expect(checkNativeAddress('5NotAnAddress', SS58_PREFIX).ok).toBe(false);
  });
});
