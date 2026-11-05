// Runs the PRD's live scenarios S1-S7 against a running Payout Replay API that
// is configured for Portaldot V3, signing with the testnet keys in internal/.
// It drives the same endpoints the web app uses and writes
// docs/real-run-results.md from the receipts it observed, misses included.
//
//   API_URL=http://localhost:8787 WEB_ORIGIN=http://localhost:3100 pnpm scenarios
import '@polkadot/api-augment';

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NativeAdapter } from '@payout-replay/adapters-native';
import { stringToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { type Hex, createPublicClient, createWalletClient, defineChain, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { EVM_CHAIN_ID, EVM_RPC_URL, GENESIS, NATIVE_WS_URL, loadDeployment, loadKeys } from './env.js';
import { connectNative, nativePair, signTransfer } from './native.js';

const API_URL = process.env.API_URL ?? 'http://localhost:8787';
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3100';
const RESULTS_PATH = fileURLToPath(new URL('../../docs/real-run-results.md', import.meta.url));
const EVIDENCE_DIR = fileURLToPath(new URL('../../docs/evidence/', import.meta.url));

const keys = loadKeys();
const deployment = loadDeployment();
const chain = defineChain({
  id: EVM_CHAIN_ID,
  name: 'Portaldot V3 Testnet',
  nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC_URL] } },
});
const evmAccount = privateKeyToAccount(keys.evm.privateKey);
const evmWallet = createWalletClient({ account: evmAccount, chain, transport: http(EVM_RPC_URL) });
const evmReader = createPublicClient({ chain, transport: http(EVM_RPC_URL, { timeout: 60_000 }) });
const api = await connectNative();
const nativeKey = await nativePair(keys.native.mnemonic);

let cookie = '';
let keyCounter = 0;
async function call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  keyCounter += 1;
  const response = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(method === 'POST' ? { 'idempotency-key': idempotencyKey ?? `live-${Date.now()}-${keyCounter}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  return (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T;
}

function signNative(message: string): string {
  return u8aToHex(nativeKey.sign(u8aWrapBytes(stringToU8a(message))));
}

const log: string[] = [];
const started = Date.now();
function note(line: string): void {
  const stamp = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  console.log(`[${stamp}] ${line}`);
  log.push(`- \`${stamp}\` ${line}`);
}

interface Line {
  lineId: string;
  obligationId: Hex;
  status: string;
  attempts: { txHash: string | null; blockHash: string | null; blockNumber: string | null; extrinsicIndex: number | null; logIndex: number | null; outcome: { kind: string } }[];
}

async function lines(runId: string): Promise<Line[]> {
  await call('POST', `/runs/${runId}/reconcile`, {});
  return (await call<{ items: Line[] }>('GET', `/runs/${runId}/lines?limit=500`)).items;
}

async function waitForStatuses(runId: string, expected: Record<string, string>, timeoutMs = 300_000): Promise<Line[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await lines(runId);
    const pending = Object.entries(expected).filter(([lineId, status]) => current.find((line) => line.lineId === lineId)?.status !== status);
    if (pending.length === 0) return current;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${pending.map(([lineId, status]) => `${lineId}=${status}`).join(', ')}; now ${current.map((line) => `${line.lineId}=${line.status}`).join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 6_000));
  }
}

async function sendEvm(to: Hex, data: Hex): Promise<{ hash: Hex; nonce: number }> {
  const nonce = await evmReader.getTransactionCount({ address: evmAccount.address, blockTag: 'pending' });
  const hash = await evmWallet.sendTransaction({ to, data, nonce });
  return { hash, nonce };
}

// Revive meters storage deposits as gas, so a fixed EVM-style limit like 3M is
// rejected outright. Transactions that must revert on-chain (S3, the duplicate)
// cannot be estimated, so they reuse the limit measured on the successful S2.
let executeGas: bigint | undefined;
function revertingExecuteGas(): bigint {
  if (executeGas === undefined) throw new Error('S2 must run first to size the gas for reverting executes');
  return executeGas;
}

// Recipients are reused across runs, so balance checks compare deltas, never absolutes.
function tokenBalance(owner: Hex): Promise<bigint> {
  return evmReader.readContract({
    address: deployment.token,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [owner],
  });
}

const results: { id: string; name: string; expected: string; observed: string; pass: boolean; refs: string[] }[] = [];
function record(id: string, name: string, expected: string, observed: string, pass: boolean, refs: string[]): void {
  results.push({ id, name, expected, observed, pass, refs });
  note(`${pass ? 'PASS' : 'MISS'} ${id} ${name}: ${observed}`);
}

try {
  note(`API ${API_URL}, native ${NATIVE_WS_URL}, EVM ${EVM_RPC_URL} (chain ${EVM_CHAIN_ID})`);

  // Sign in with the EVM key, link the native key, create an org, bind both payout wallets.
  const evmChallenge = await call<{ challengeId: string; message: string }>('POST', '/auth/challenge', { environment: 'evm', address: evmAccount.address });
  await call('POST', '/auth/verify', { challengeId: evmChallenge.challengeId, signature: await evmAccount.signMessage({ message: evmChallenge.message }) });
  const nativeChallenge = await call<{ challengeId: string; message: string }>('POST', '/auth/challenge', { environment: 'native', address: nativeKey.address });
  await call('POST', '/auth/verify', { challengeId: nativeChallenge.challengeId, signature: signNative(nativeChallenge.message), link: true });
  const org = await call<{ id: string }>('POST', '/orgs', { name: 'Payout Replay live run', slug: `live-${Date.now().toString(36)}` });
  for (const [environment, address, sign] of [
    ['evm', evmAccount.address, (message: string) => evmAccount.signMessage({ message })],
    ['native', nativeKey.address, async (message: string) => signNative(message)],
  ] as const) {
    const challenge = await call<{ challengeId: string; message: string }>('POST', `/orgs/${org.id}/wallet-challenges`, { environment, address });
    await call('POST', `/orgs/${org.id}/wallets`, { challengeId: challenge.challengeId, signature: await sign(challenge.message) });
  }
  note(`org ${org.id} with native ${nativeKey.address} and EVM ${evmAccount.address}`);

  const [nativeA, nativeB] = keys.recipients.native;
  const [evmA, evmB, evmC] = keys.recipients.evm;
  const csv = [
    'line_id,environment,asset_id,destination,amount,reference,recipient_name',
    `S1-A,native,tPOT,${nativeA!.address},1.5,S1-A,Native recipient A`,
    `S1-B,native,tPOT,${nativeB!.address},0.25,S1-B,Native recipient B`,
    `S2,evm,${deployment.token},${evmA},25,S2,EVM recipient A`,
    `S3,evm,${deployment.token},${evmB},40.5,S3,EVM recipient B`,
    `S5,evm,${deployment.token},${evmC},10,S5,EVM recipient C`,
  ].join('\n');
  const run = await call<{ id: string }>('POST', `/orgs/${org.id}/runs`, { name: `Live V3 scenarios ${new Date().toISOString().slice(0, 16)}` });
  const imported = await call<{ report: { ok: boolean; issues: unknown[] } }>('POST', `/runs/${run.id}/import`, { csv, fileName: 'live-scenarios.csv' });
  if (!imported.report.ok) throw new Error(`import failed: ${JSON.stringify(imported.report.issues)}`);
  const frozen = await call<{ version: number; digest: string }>('POST', `/runs/${run.id}/freeze`, { acknowledgeDuplicates: false });
  await call('POST', `/runs/${run.id}/approvals`, { version: frozen.version, digest: frozen.digest, decision: 'approve' });
  note(`run ${run.id} frozen as v${frozen.version} ${frozen.digest} and approved`);

  const byLine = new Map((await lines(run.id)).map((line) => [line.lineId, line]));
  const plan = await call<{ planId: string }>('POST', `/runs/${run.id}/execute/plan`, {});

  // S1: native transfers, signed with a mortal era and recorded before broadcast.
  for (const lineId of ['S1-A', 'S1-B']) {
    const line = byLine.get(lineId)!;
    const [transfer] = (await call<{ transfers: { payload: { dest: string; value: string } }[] }>('POST', `/recovery-plans/${plan.planId}/revalidate`, { environment: 'native', obligationIds: [line.obligationId] })).transfers;
    const attempt = await call<{ id: string }>('POST', `/runs/${run.id}/attempts`, { planId: plan.planId, obligationId: line.obligationId });
    const signed = await signTransfer(api, nativeKey, transfer!.payload.dest, BigInt(transfer!.payload.value));
    let phase: 'submitted' | 'submission_unknown' = 'submitted';
    try {
      await signed.send();
    } catch (error) {
      phase = 'submission_unknown';
      note(`${lineId} broadcast error: ${(error as Error).message}`);
    }
    await call('POST', `/attempts/${attempt.id}/result`, { phase, txHash: signed.txHash, nonce: signed.nonce, mortality: signed.mortality });
    note(`${lineId} signed ${signed.txHash} (nonce ${signed.nonce}, era #${signed.mortality.birthBlock}+${signed.mortality.period})`);
  }

  // S2: normal EVM payout through the executor.
  const payEvm = async (lineId: string, options: { revokeAllowanceFirst?: boolean } = {}) => {
    const line = byLine.get(lineId)!;
    const planId = (await call<{ latestPlan: { id: string } }>('GET', `/runs/${run.id}`)).latestPlan.id;
    const [transfer] = (await call<{ transfers: { payload: { approve: { to: Hex; data: Hex } | null; execute: { to: Hex; data: Hex } } }[] }>('POST', `/recovery-plans/${planId}/revalidate`, { environment: 'evm', obligationIds: [line.obligationId] })).transfers;
    if (transfer!.payload.approve) {
      const approval = await sendEvm(transfer!.payload.approve.to, transfer!.payload.approve.data);
      await evmReader.waitForTransactionReceipt({ hash: approval.hash, timeout: 180_000 });
      note(`${lineId} exact-amount approval ${approval.hash}`);
    }
    if (options.revokeAllowanceFirst) {
      const revokeData = encodeFunctionData({
        abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
        functionName: 'approve',
        args: [deployment.executor, 0n],
      });
      const revoke = await sendEvm(deployment.token, revokeData);
      await evmReader.waitForTransactionReceipt({ hash: revoke.hash, timeout: 180_000 });
      note(`${lineId} allowance reset to 0 out of band by ${revoke.hash} (forces an on-chain revert)`);
    }
    const attempt = await call<{ id: string }>('POST', `/runs/${run.id}/attempts`, { planId, obligationId: line.obligationId });
    const { to, data } = transfer!.payload.execute;
    if (!options.revokeAllowanceFirst) executeGas = ((await evmReader.estimateGas({ account: evmAccount, to, data })) * 3n) / 2n;
    // revive's eth-rpc only knows a transaction once it is in a block, so the nonce is fixed before sending.
    const nonce = await evmReader.getTransactionCount({ address: evmAccount.address, blockTag: 'pending' });
    const sent = { hash: await evmWallet.sendTransaction({ to, data, gas: revertingExecuteGas(), nonce }), nonce };
    await call('POST', `/attempts/${attempt.id}/result`, { phase: 'submitted', txHash: sent.hash, nonce: sent.nonce });
    note(`${lineId} executePayment ${sent.hash} (nonce ${sent.nonce})`);
    return sent.hash;
  };
  await payEvm('S2');

  // S3: a payment that reverts on-chain because its allowance was revoked out of band.
  const s3RecipientBefore = await tokenBalance(evmB!);
  await payEvm('S3', { revokeAllowanceFirst: true });

  // S5: controlled failure injection. The attempt is opened and reported as
  // "submission unknown" without broadcasting anything, which is what a lost
  // wallet response looks like to the app. No chain transaction exists.
  {
    const line = byLine.get('S5')!;
    const planId = (await call<{ latestPlan: { id: string } }>('GET', `/runs/${run.id}`)).latestPlan.id;
    await call('POST', `/recovery-plans/${planId}/revalidate`, { environment: 'evm', obligationIds: [line.obligationId] });
    const attempt = await call<{ id: string }>('POST', `/runs/${run.id}/attempts`, { planId, obligationId: line.obligationId });
    await call('POST', `/attempts/${attempt.id}/result`, { phase: 'submission_unknown' });
    note('S5 attempt recorded as submission_unknown with no transaction (disclosed failure injection)');
  }

  const settled = await waitForStatuses(run.id, { 'S1-A': 'paid_verified', 'S1-B': 'paid_verified', S2: 'paid_verified', S3: 'failed_verified', S5: 'needs_review' });
  const get = (lineId: string) => settled.find((line) => line.lineId === lineId)!;
  const evidenceOf = (line: Line) => line.attempts.filter((attempt) => attempt.txHash).map((attempt) => `${attempt.txHash} @ block ${attempt.blockNumber ?? '?'} (${attempt.blockHash ?? '?'})${attempt.extrinsicIndex !== null ? ` extrinsic ${attempt.extrinsicIndex}` : ''}${attempt.logIndex !== null ? ` log ${attempt.logIndex}` : ''}: ${attempt.outcome.kind}`);
  for (const lineId of ['S1-A', 'S1-B']) {
    record('S1', `native payout ${lineId}`, 'paid_verified with finalised extrinsic proof', get(lineId).status, get(lineId).status === 'paid_verified', evidenceOf(get(lineId)));
  }
  record('S2', 'EVM payout', 'paid_verified with executor and Transfer events', get('S2').status, get('S2').status === 'paid_verified', evidenceOf(get('S2')));
  record('S3', 'definitive failure', 'failed_verified, not paid', get('S3').status, get('S3').status === 'failed_verified', evidenceOf(get('S3')));

  // S5 must be blocked from recovery; S3 must be the only eligible line.
  const recovery = await call<{ planId: string; plan: { eligible: { lineId: string }[]; blocked: { lineId: string; status: string }[] } }>('POST', `/runs/${run.id}/recovery-plans`, {});
  const eligible = recovery.plan.eligible.map((line) => line.lineId);
  record(
    'S5',
    'ambiguous attempt',
    'needs_review and excluded from recovery',
    `${get('S5').status}; recovery eligible = [${eligible.join(', ')}]`,
    get('S5').status === 'needs_review' && !eligible.includes('S5'),
    ['controlled failure injection: no transaction was broadcast'],
  );

  // S4: correct S3 with a fresh signature, reusing its obligation ID.
  await payEvm('S3');
  const corrected = await waitForStatuses(run.id, { S3: 'paid_verified' });
  const s3 = corrected.find((line) => line.lineId === 'S3')!;
  const s3Received = (await tokenBalance(evmB!)) - s3RecipientBefore;
  record('S4', 'safe correction', 'S3 paid exactly once through the executor', `${s3.status}; recipient received ${s3Received} base units`, s3.status === 'paid_verified' && s3Received === 40_500_000n, evidenceOf(s3));

  // S6: call the executor directly with S2's obligation ID again.
  const s2 = get('S2');
  const duplicateData = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'executePayment',
        stateMutability: 'nonpayable',
        inputs: [{ type: 'tuple', components: [{ name: 'obligationId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'manifestDigest', type: 'bytes32' }] }],
        outputs: [],
      },
    ],
    functionName: 'executePayment',
    args: [{ obligationId: s2.obligationId, token: deployment.token, recipient: evmA!, amount: 25_000_000n, manifestDigest: `0x${frozen.digest.slice(7)}` }],
  });
  const approveAgain = encodeFunctionData({
    abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'approve',
    args: [deployment.executor, 25_000_000n],
  });
  await evmReader.waitForTransactionReceipt({ hash: (await sendEvm(deployment.token, approveAgain)).hash, timeout: 180_000 });
  const s2RecipientBefore = await tokenBalance(evmA!);
  const duplicate = await evmWallet.sendTransaction({ to: deployment.executor, data: duplicateData, gas: revertingExecuteGas() });
  const duplicateReceipt = await evmReader.waitForTransactionReceipt({ hash: duplicate, timeout: 180_000 });
  const duplicateMoved = (await tokenBalance(evmA!)) - s2RecipientBefore;
  record(
    'S6',
    'duplicate payment ID',
    'on-chain revert, no second transfer',
    `receipt ${duplicateReceipt.status}; recipient balance moved by ${duplicateMoved} base units`,
    duplicateReceipt.status === 'reverted' && duplicateMoved === 0n,
    [`${duplicate} @ block ${duplicateReceipt.blockNumber}`],
  );

  // S7: export.
  const exported = await call<string>('GET', `/runs/${run.id}/export.csv`);
  const exceptionsCsv = await call<string>('GET', `/runs/${run.id}/exceptions.csv`);
  const evidence = await call<Record<string, unknown>>('GET', `/runs/${run.id}/evidence.json`);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(`${EVIDENCE_DIR}${run.id}-reconciliation.csv`, exported);
  writeFileSync(`${EVIDENCE_DIR}${run.id}-exceptions.csv`, exceptionsCsv);
  writeFileSync(`${EVIDENCE_DIR}${run.id}-evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  const rows = exported.trim().split('\r\n');
  const statuses = rows.slice(1).map((row) => row.split(',').find((cell) => ['paid_verified', 'needs_review', 'failed_verified'].includes(cell)));
  record(
    'S7',
    'reporting',
    '5 original rows; 4 paid_verified, 1 needs_review; exact base units',
    `${rows.length - 1} rows; ${statuses.filter((status) => status === 'paid_verified').length} paid_verified, ${statuses.filter((status) => status === 'needs_review').length} needs_review`,
    rows.length === 6 && statuses.filter((status) => status === 'paid_verified').length === 4 && statuses.includes('needs_review') && exported.includes(',40500000,'),
    [`docs/evidence/${run.id}-reconciliation.csv`, `docs/evidence/${run.id}-exceptions.csv`, `docs/evidence/${run.id}-evidence.json`],
  );

  const native = new NativeAdapter({ wsUrl: NATIVE_WS_URL, expectedGenesisHash: GENESIS });
  const identity = await native.getNetworkIdentity();
  await native.disconnect();

  const passed = results.filter((result) => result.pass).length;
  const report = [
    '# Real run results',
    '',
    `Generated by \`scripts/live/scenarios.ts\` on ${new Date().toISOString()} against Portaldot V3 testnet. Every transaction below is real; the only injected condition is S5, which is disclosed.`,
    '',
    `**${passed} of ${results.length} scenario checks passed.**`,
    '',
    '## Network',
    '',
    `- Native runtime: ${identity.specName} v${identity.specVersion}, genesis \`${identity.genesisHash}\`, ${identity.tokenSymbol} with ${identity.tokenDecimals} decimals, SS58 prefix ${identity.ss58Prefix}`,
    `- EVM: chain ${EVM_CHAIN_ID} (pallet-revive eth-rpc at ${EVM_RPC_URL})`,
    `- PayoutExecutor \`${deployment.executor}\` (code hash \`${deployment.executorCodeHash}\`), TEST TOKEN PRT \`${deployment.token}\`, deployed at block ${deployment.deployBlock}`,
    `- Native payout wallet \`${nativeKey.address}\`, EVM payout wallet \`${evmAccount.address}\``,
    `- Run \`${run.id}\`, manifest v${frozen.version} \`${frozen.digest}\``,
    '',
    '## Scenarios',
    '',
    '| ID | Scenario | Expected | Observed | Result |',
    '|---|---|---|---|---|',
    ...results.map((result) => `| ${result.id} | ${result.name} | ${result.expected} | ${result.observed} | ${result.pass ? 'pass' : '**miss**'} |`),
    '',
    '## Transaction references',
    '',
    ...results.flatMap((result) => [`### ${result.id} ${result.name}`, '', ...result.refs.map((ref) => `- ${ref}`), '']),
    '## Timeline',
    '',
    ...log,
    '',
  ].join('\n');
  writeFileSync(RESULTS_PATH, report);
  note(`wrote ${RESULTS_PATH}`);
  if (passed !== results.length) process.exitCode = 1;
} finally {
  await api.disconnect();
}
