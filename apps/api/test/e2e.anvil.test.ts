// LOCAL END-TO-END TEST: real Postgres (payout_replay_test) + anvil (chain
// 31337) + the real API, adapters and contracts. Not Portaldot evidence; the
// V3 runs are recorded in docs/real-run-results.md.
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type Hex, createTestClient, createWalletClient, getAddress, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { ChainRegistry } from '../src/chain/registry.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

const PORT = 8800 + Math.floor(Math.random() * 100);
const RPC = `http://127.0.0.1:${PORT}`;
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost/payout_replay_test';
const ORIGIN = 'http://localhost:3000';
const OWNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OUTSIDER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const CAROL = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const DAVE = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const ERIN = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';

const chain = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC) }).extend(publicActions);
const deployer = createWalletClient({ account: DEPLOYER, chain: foundry, transport: http(RPC) });
const ownerWallet = createWalletClient({ account: OWNER, chain: foundry, transport: http(RPC) });

function artifact(name: string): { abi: unknown[]; bytecode: Hex } {
  const path = fileURLToPath(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url));
  const json = JSON.parse(readFileSync(path, 'utf8')) as { abi: unknown[]; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function deploy(name: string, args: unknown[]): Promise<Hex> {
  const { abi, bytecode } = artifact(name);
  const receipt = await chain.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode, args }) });
  return getAddress(receipt.contractAddress!);
}

let anvil: ChildProcess;
let app: ReturnType<typeof createApp>;
let closeDb: () => Promise<void>;
let token: Hex;
let keyCounter = 0;

interface Client {
  cookie: string;
  call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<{ status: number; body: T; text: string }>;
}

function client(): Client {
  const self: Client = {
    cookie: '',
    async call(method, path, body, extra = {}) {
      keyCounter += 1;
      const response = await app.request(`/api/v1${path}`, {
        method,
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          ...(method === 'GET' ? {} : { 'idempotency-key': `test-key-${Date.now()}-${keyCounter}` }),
          ...(self.cookie ? { cookie: self.cookie } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) self.cookie = setCookie.split(';')[0]!;
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed as never, text };
    },
  };
  return self;
}

async function signIn(api: Client, account: typeof OWNER): Promise<void> {
  const challenge = await api.call<{ challengeId: string; message: string }>('POST', '/auth/challenge', { environment: 'evm', address: account.address });
  const signature = await account.signMessage({ message: challenge.body.message });
  const verified = await api.call('POST', '/auth/verify', { challengeId: challenge.body.challengeId, signature });
  expect(verified.status).toBe(200);
}

async function finalize(): Promise<void> {
  await chain.mine({ blocks: 70 });
}

async function send(call: { to: Hex; data: Hex }): Promise<Hex> {
  const hash = await ownerWallet.sendTransaction({ ...call, gas: 300_000n });
  await chain.waitForTransactionReceipt({ hash });
  return hash;
}

interface Transfer {
  obligationId: Hex;
  payload: { approve: { to: Hex; data: Hex } | null; execute: { to: Hex; data: Hex } };
  preflight: { code: string; blocking: boolean }[];
}

const owner = client();
const outsider = client();
let orgId: string;
let runId: string;
let lines: { lineId: string; obligationId: Hex; status: string }[];

const byLine = (lineId: string) => lines.find((line) => line.lineId === lineId)!;

async function refreshLines(): Promise<void> {
  await owner.call('POST', `/runs/${runId}/reconcile`, {});
  const result = await owner.call<{ items: typeof lines }>('GET', `/runs/${runId}/lines`);
  lines = result.body.items;
}

async function revalidate(planId: string, obligationIds: Hex[]): Promise<Transfer[]> {
  const result = await owner.call<{ transfers: Transfer[] }>('POST', `/recovery-plans/${planId}/revalidate`, { environment: 'evm', obligationIds });
  expect(result.status, result.text).toBe(200);
  return result.body.transfers;
}

async function prepare(planId: string, obligationId: Hex): Promise<string> {
  const nonce = await chain.getTransactionCount({ address: OWNER.address });
  const result = await owner.call<{ id: string }>('POST', `/runs/${runId}/attempts`, { planId, obligationId, nonce });
  expect(result.status, result.text).toBe(201);
  return result.body.id;
}

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    try {
      await chain.getChainId();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const executor = await deploy('PayoutExecutor', [DEPLOYER.address]);
  token = await deploy('TestToken', [DEPLOYER.address]);
  await chain.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: executor, abi: artifact('PayoutExecutor').abi, functionName: 'setTokenAllowlisted', args: [token, true] }),
  });
  await chain.waitForTransactionReceipt({
    hash: await deployer.writeContract({ address: token, abi: artifact('TestToken').abi, functionName: 'mint', args: [OWNER.address, 1_000_000_000n] }),
  });

  const sql = postgres(DB_URL, { onnotice: () => undefined });
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql.end();
  await runMigrations(DB_URL);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-0123',
    WEB_ORIGIN: ORIGIN,
    EVM_RPC_URL: RPC,
    EVM_CHAIN_ID: '31337',
    EVM_EXECUTOR_ADDRESS: executor,
    EVM_TOKENS: token,
    RECONCILE_DEBOUNCE_MS: '0',
    WORKER_ENABLED: 'false',
  });
  const database = createDatabase(DB_URL);
  closeDb = database.close;
  app = createApp({ db: database.db, config, chains: new ChainRegistry(config) });
}, 60_000);

afterAll(async () => {
  anvil?.kill();
  await closeDb?.();
});

describe('payout loop on anvil', () => {
  it('signs in with a wallet signature and creates an organisation', async () => {
    await signIn(owner, OWNER);
    const org = await owner.call<{ id: string }>('POST', '/orgs', { name: 'Fixture DAO', slug: 'fixture-dao' });
    orgId = org.body.id;
    expect(org.status).toBe(201);
  });

  it('registers the EVM payout wallet only after verifying its signature', async () => {
    const challenge = await owner.call<{ challengeId: string; message: string }>('POST', `/orgs/${orgId}/wallet-challenges`, { environment: 'evm', address: OWNER.address });
    const forged = await OUTSIDER.signMessage({ message: challenge.body.message });
    const rejected = await owner.call('POST', `/orgs/${orgId}/wallets`, { challengeId: challenge.body.challengeId, signature: forged });
    const retry = await owner.call<{ challengeId: string; message: string }>('POST', `/orgs/${orgId}/wallet-challenges`, { environment: 'evm', address: OWNER.address });
    const accepted = await owner.call('POST', `/orgs/${orgId}/wallets`, {
      challengeId: retry.body.challengeId,
      signature: await OWNER.signMessage({ message: retry.body.message }),
    });
    expect([rejected.status, accepted.status]).toEqual([401, 201]);
  });

  it('imports, reports errors per line, then freezes and approves an exact digest', async () => {
    const run = await owner.call<{ id: string }>('POST', `/orgs/${orgId}/runs`, { name: 'November contributors' });
    runId = run.body.id;
    const bad = await owner.call<{ report: { ok: boolean; issues: { code: string }[] } }>('POST', `/runs/${runId}/import`, {
      csv: `line_id,environment,asset_id,destination,amount,reference\nA,evm,${token},${CAROL},1.0000001,r`,
    });
    expect([bad.body.report.ok, bad.body.report.issues[0]?.code]).toEqual([false, 'AMOUNT_PRECISION']);

    const csv = [
      'line_id,environment,asset_id,destination,amount,reference,recipient_name',
      `TASK-201,evm,${token},${CAROL},25,TASK-201,Carol`,
      `TASK-202,evm,${token},${DAVE},40.5,TASK-202,Dave`,
      `TASK-203,evm,${token},${ERIN},10,TASK-203,"=HYPERLINK(""x"")"`,
    ].join('\n');
    const good = await owner.call<{ report: { ok: boolean } }>('POST', `/runs/${runId}/import`, { csv, fileName: 'november.csv' });
    expect(good.body.report.ok, JSON.stringify(good.body)).toBe(true);

    const frozen = await owner.call<{ version: number; digest: string }>('POST', `/runs/${runId}/freeze`, { acknowledgeDuplicates: false });
    const wrongDigest = await owner.call('POST', `/runs/${runId}/approvals`, { version: 1, digest: 'sha256:00', decision: 'approve' });
    const approved = await owner.call('POST', `/runs/${runId}/approvals`, { version: frozen.body.version, digest: frozen.body.digest, decision: 'approve' });
    expect([frozen.status, wrongDigest.status, approved.status]).toEqual([201, 409, 200]);
  });

  it('refuses an outsider with the same 404 as a missing run', async () => {
    await signIn(outsider, OUTSIDER);
    const result = await outsider.call('GET', `/runs/${runId}`);
    expect(result.status).toBe(404);
  });

  it('S2: pays one line through the executor and verifies it only after finality', async () => {
    await refreshLines();
    const plan = await owner.call<{ planId: string; plan: { eligible: unknown[] } }>('POST', `/runs/${runId}/execute/plan`, { environment: 'evm' });
    expect(plan.body.plan.eligible).toHaveLength(3);
    const [transfer] = await revalidate(plan.body.planId, [byLine('TASK-201').obligationId]);
    const attemptId = await prepare(plan.body.planId, transfer!.obligationId);
    await send(transfer!.payload.approve!);
    const txHash = await send(transfer!.payload.execute);
    await owner.call('POST', `/attempts/${attemptId}/result`, { phase: 'submitted', txHash });
    await refreshLines();
    const before = byLine('TASK-201').status;
    await finalize();
    await refreshLines();
    expect([before, byLine('TASK-201').status]).toEqual(['confirming', 'paid_verified']);
  });

  it('S3: classifies a reverted payment (no allowance) as failed_verified', async () => {
    const plan = await owner.call<{ planId: string }>('POST', `/runs/${runId}/execute/plan`, { environment: 'evm' });
    const [transfer] = await revalidate(plan.body.planId, [byLine('TASK-202').obligationId]);
    const attemptId = await prepare(plan.body.planId, transfer!.obligationId);
    const txHash = await send(transfer!.payload.execute);
    await owner.call('POST', `/attempts/${attemptId}/result`, { phase: 'submitted', txHash });
    await finalize();
    await refreshLines();
    expect(byLine('TASK-202').status).toBe('failed_verified');
  });

  it('S5: blocks a line whose submission outcome is unknown', async () => {
    const plan = await owner.call<{ planId: string }>('POST', `/runs/${runId}/execute/plan`, { environment: 'evm' });
    await revalidate(plan.body.planId, [byLine('TASK-203').obligationId]);
    const attemptId = await prepare(plan.body.planId, byLine('TASK-203').obligationId);
    await owner.call('POST', `/attempts/${attemptId}/result`, { phase: 'submission_unknown' });
    await refreshLines();
    expect(byLine('TASK-203').status).toBe('needs_review');
  });

  it('S4: the recovery plan offers only the conclusive failure and pays it exactly once', async () => {
    const plan = await owner.call<{ planId: string; plan: { eligible: { lineId: string }[]; blocked: { lineId: string; status: string }[] } }>(
      'POST',
      `/runs/${runId}/recovery-plans`,
      {},
    );
    expect({
      eligible: plan.body.plan.eligible.map((line) => line.lineId),
      blocked: plan.body.plan.blocked.map((line) => [line.lineId, line.status]),
    }).toEqual({
      eligible: ['TASK-202'],
      blocked: [
        ['TASK-201', 'paid_verified'],
        ['TASK-203', 'needs_review'],
      ],
    });
    const [transfer] = await revalidate(plan.body.planId, [byLine('TASK-202').obligationId]);
    const attemptId = await prepare(plan.body.planId, transfer!.obligationId);
    await send(transfer!.payload.approve!);
    const txHash = await send(transfer!.payload.execute);
    await owner.call('POST', `/attempts/${attemptId}/result`, { phase: 'submitted', txHash });
    await finalize();
    await refreshLines();
    const balance = await chain.readContract({ address: token, abi: artifact('TestToken').abi, functionName: 'balanceOf', args: [DAVE] });
    expect([byLine('TASK-202').status, balance]).toEqual(['paid_verified', 40_500_000n]);
  });

  it('refuses to prepare a second attempt for a line that is already paid', async () => {
    const plan = await owner.call<{ planId: string; plan: { eligible: unknown[] } }>('POST', `/runs/${runId}/recovery-plans`, {});
    const revalidated = await owner.call('POST', `/recovery-plans/${plan.body.planId}/revalidate`, { environment: 'evm' });
    expect([plan.body.plan.eligible.length, revalidated.status]).toEqual([0, 422]);
  });

  it('S7: exports every original line with statuses, exact base units and sanitised cells', async () => {
    const csv = await owner.call('GET', `/runs/${runId}/export.csv`);
    const rows = csv.text.trim().split('\r\n');
    expect({
      rows: rows.length,
      paid: rows.filter((row) => row.includes(',paid_verified,')).length,
      review: rows.filter((row) => row.includes(',needs_review,')).length,
      exact: rows.some((row) => row.includes(',40500000,')),
      sanitised: rows.some((row) => row.includes(`"'=HYPERLINK(""x"")"`)),
    }).toEqual({ rows: 4, paid: 2, review: 1, exact: true, sanitised: true });
  });

  it('replays an idempotent request instead of repeating it', async () => {
    const headers = { 'idempotency-key': 'fixed-key-123456' };
    const first = await owner.call<{ id: string }>('POST', `/orgs/${orgId}/runs`, { name: 'Replay me' }, headers);
    const second = await owner.call<{ id: string }>('POST', `/orgs/${orgId}/runs`, { name: 'Replay me' }, headers);
    const conflict = await owner.call('POST', `/orgs/${orgId}/runs`, { name: 'Different body' }, headers);
    expect([first.body.id === second.body.id, conflict.status]).toEqual([true, 409]);
  });

  it('rejects cookie-authenticated writes from another origin', async () => {
    const result = await owner.call('POST', `/orgs/${orgId}/runs`, { name: 'csrf' }, { origin: 'https://evil.example' });
    expect(result.status).toBe(403);
  });

  it('keeps frozen obligations immutable at the database level', async () => {
    const sql = postgres(DB_URL, { onnotice: () => undefined });
    try {
      await expect(sql`UPDATE obligations SET amount_base_units = 1`).rejects.toThrow(/frozen/);
    } finally {
      await sql.end();
    }
  });
});
