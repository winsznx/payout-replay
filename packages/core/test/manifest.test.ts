import { describe, expect, it } from 'vitest';

import { freezeManifest, validateManifestCsv, verifyManifestDigest } from '../src/manifest.js';
import { deriveObligationId } from '../src/obligation-id.js';
import {
  ASSETS,
  CONTEXT,
  EVM_CAROL,
  EVM_PAYER,
  NATIVE_ALICE,
  NATIVE_ALICE_OTHER_PREFIX,
  NETWORK,
  PAYERS,
  TEST_TOKEN,
  VALID_CSV,
} from './fixtures.js';

const HEADER = 'line_id,environment,asset_id,destination,amount,reference';

function codesFor(csv: string): string[] {
  return validateManifestCsv(csv, CONTEXT).issues.map((issue) => issue.code);
}

describe('validateManifestCsv', () => {
  it('should accept a well-formed mixed native and EVM sheet', () => {
    // #given a sheet with one native and two EVM rows
    // #when it is validated
    const report = validateManifestCsv(VALID_CSV, CONTEXT);
    // #then every row survives with exact base units
    expect({ ok: report.ok, amounts: report.lines.map((line) => line.amountBaseUnits) }).toEqual({
      ok: true,
      amounts: ['5000000000000000', '100250000', '7000000'],
    });
  });

  it('should total per asset without mixing denominations', () => {
    const report = validateManifestCsv(VALID_CSV, CONTEXT);
    expect(report.totals.map((total) => [total.symbol, total.count, total.amountBaseUnits])).toEqual([
      ['PRT', 2, '107250000'],
      ['tPOT', 1, '5000000000000000'],
    ]);
  });

  it.each([
    [`${HEADER}\nA,native,tPOT,${NATIVE_ALICE},1,r\nA,native,tPOT,${NATIVE_ALICE},2,r`, 'LINE_ID_DUPLICATE'],
    [`${HEADER}\na,native,tPOT,${NATIVE_ALICE},1,r\nA,native,tPOT,${NATIVE_ALICE},2,r`, 'LINE_ID_DUPLICATE'],
    [`${HEADER}\nA,solana,tPOT,${NATIVE_ALICE},1,r`, 'ENVIRONMENT_INVALID'],
    [`${HEADER}\nA,native,DOT,${NATIVE_ALICE},1,r`, 'ASSET_UNKNOWN'],
    [`${HEADER}\nA,evm,tPOT,${EVM_CAROL},1,r`, 'ASSET_UNKNOWN'],
    [`${HEADER}\nA,native,tPOT,${EVM_CAROL},1,r`, 'DESTINATION_INVALID'],
    [`${HEADER}\nA,evm,${TEST_TOKEN},${NATIVE_ALICE},1,r`, 'DESTINATION_INVALID'],
    [`${HEADER}\nA,evm,${TEST_TOKEN},${EVM_CAROL},1.1234567,r`, 'AMOUNT_PRECISION'],
    [`${HEADER}\nA,evm,${TEST_TOKEN},${EVM_CAROL},0,r`, 'AMOUNT_NOT_POSITIVE'],
    [`${HEADER}\nA,evm,${TEST_TOKEN},${EVM_CAROL},1,`, 'REFERENCE_REQUIRED'],
    [`${HEADER}\nA,evm,${TEST_TOKEN},${EVM_PAYER},1,r`, 'DESTINATION_IS_PAYER'],
    [`${HEADER},source_wallet\nA,evm,${TEST_TOKEN},${EVM_CAROL},1,r,${EVM_CAROL}`, 'SOURCE_WALLET_MISMATCH'],
    ['line_id,environment,asset_id,destination,amount\nA,evm,x,y,1', 'MISSING_COLUMN'],
    [`${HEADER}\n`, 'NO_ROWS'],
    [`${HEADER}\nA,"evm`, 'CSV_SYNTAX'],
  ])('should reject invalid input with %#', (csv, code) => {
    expect(codesFor(csv)).toContain(code);
  });

  it('should refuse lines when the environment has no configured payer', () => {
    const report = validateManifestCsv(`${HEADER}\nA,native,tPOT,${NATIVE_ALICE},1,r`, { ...CONTEXT, payers: { evm: EVM_PAYER } });
    expect(report.issues.map((issue) => issue.code)).toEqual(['PAYER_MISSING']);
  });

  it('should block assets whose network capability is not verified', () => {
    const assets = ASSETS.map((asset) => (asset.environment === 'evm' ? { ...asset, capability: 'unverified' as const } : asset));
    const report = validateManifestCsv(`${HEADER}\nA,evm,${TEST_TOKEN},${EVM_CAROL},1,r`, { ...CONTEXT, assets });
    expect(report.ok).toBe(false);
  });

  it('should keep duplicate-looking rows as distinct obligations that need acknowledgement', () => {
    // #given two rows paying the same recipient the same amount
    const csv = `${HEADER}\nA,evm,${TEST_TOKEN},${EVM_CAROL},5,r1\nB,evm,${TEST_TOKEN},${EVM_CAROL},5.0,r2`;
    // #when validated
    const report = validateManifestCsv(csv, CONTEXT);
    // #then both survive, flagged, and acknowledgement is required
    expect({ ok: report.ok, lines: report.lines.length, ack: report.requiresAcknowledgement, group: report.duplicates[0]?.lineIds }).toEqual({
      ok: true,
      lines: 2,
      ack: true,
      group: ['A', 'B'],
    });
  });

  it('should warn and canonicalise SS58 addresses with a foreign prefix', () => {
    const report = validateManifestCsv(`${HEADER}\nA,native,tPOT,${NATIVE_ALICE_OTHER_PREFIX},1,r`, CONTEXT);
    expect([report.ok, report.lines[0]?.destination, report.issues[0]?.code]).toEqual([true, NATIVE_ALICE, 'DESTINATION_REENCODED']);
  });

  it('should honour a column mapping for differently named headers', () => {
    const csv = `id,env,token,to,amt,ref\nA,evm,${TEST_TOKEN},${EVM_CAROL},1,r`;
    const report = validateManifestCsv(csv, {
      ...CONTEXT,
      columnMapping: { line_id: 'id', environment: 'env', asset_id: 'token', destination: 'to', amount: 'amt', reference: 'ref' },
    });
    expect(report.ok).toBe(true);
  });

  it('should enforce row and size limits', () => {
    const rows = Array.from({ length: 3 }, (_, index) => `L${index},evm,${TEST_TOKEN},${EVM_CAROL},1,r`);
    expect(validateManifestCsv(`${HEADER}\n${rows.join('\n')}`, { ...CONTEXT, limits: { maxBytes: 10_000, maxLines: 2 } }).issues[0]?.code).toBe('TOO_MANY_ROWS');
    expect(validateManifestCsv(VALID_CSV, { ...CONTEXT, limits: { maxBytes: 10, maxLines: 500 } }).issues[0]?.code).toBe('FILE_TOO_LARGE');
  });
});

describe('freezeManifest', () => {
  const lines = validateManifestCsv(VALID_CSV, CONTEXT).lines;
  const freeze = (input: Partial<Parameters<typeof freezeManifest>[0]> = {}) =>
    freezeManifest({ runId: 'run_1', version: 1, network: NETWORK, payers: PAYERS, assets: ASSETS, lines, ...input });

  it('should produce the same digest regardless of row order', () => {
    expect(freeze().digest).toBe(freeze({ lines: [...lines].reverse() }).digest);
  });

  it('should change the digest when any amount changes', () => {
    const tampered = lines.map((line, index) => (index === 0 ? { ...line, amountBaseUnits: '5000000000000001' } : line));
    expect(freeze().digest).not.toBe(freeze({ lines: tampered }).digest);
  });

  it('should detect tampering of a stored manifest', () => {
    const frozen = freeze();
    const edited = structuredClone(frozen);
    edited.manifest.obligations[0]!.destination = EVM_CAROL;
    expect([verifyManifestDigest(frozen), verifyManifestDigest(edited)]).toEqual([true, false]);
  });

  it('should derive obligation IDs that differ by version, run and payer', () => {
    const base = { environment: 'evm' as const, network: NETWORK, payer: EVM_PAYER, runId: 'run_1', version: 1, lineId: 'A' };
    const ids = new Set([
      deriveObligationId(base),
      deriveObligationId({ ...base, version: 2 }),
      deriveObligationId({ ...base, runId: 'run_2' }),
      deriveObligationId({ ...base, payer: EVM_CAROL }),
      deriveObligationId({ ...base, payer: EVM_PAYER.toUpperCase().replace('0X', '0x') }),
    ]);
    expect(ids.size).toBe(4);
  });

  it('should keep a stable obligation ID for a known input', () => {
    // #given the documented encoding
    // #then the value is pinned so contract and server agree byte for byte
    expect(
      deriveObligationId({ environment: 'evm', network: NETWORK, payer: EVM_PAYER, runId: 'run_1', version: 1, lineId: 'TASK-102' }),
    ).toMatchInlineSnapshot(`"0x375e78e9b8dc5694bc211e6587233a235c6c9d0865cb36d1ac72736df8a5efbd"`);
  });
});
