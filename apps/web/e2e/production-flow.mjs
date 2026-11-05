// PRODUCTION BROWSER RUN ON PORTALDOT V3. Drives the deployed web app in Chrome
// through import, approval, native and EVM signing, an on-chain revert, recovery
// and export. The injected wallets are a test harness standing in for the
// Polkadot.js extension and an EIP-1193 wallet: each request is signed in Node
// with the testnet keys in internal/ (gitignored). Every chain effect is a real
// V3 transaction.
//
// Usage: WEB_URL=https://payout-replay.vercel.app SHOTS_DIR=/tmp/shots node e2e/production-flow.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import { hexToU8a, u8aToHex, u8aWrapBytes } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import puppeteer from 'puppeteer-core';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const WEB_URL = process.env.WEB_URL ?? 'https://payout-replay.vercel.app';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'payout-replay-production');
// RECORD_DIR records each step as a 1920x1080 clip with a visible cursor and human-paced input, for the demo film.
const RECORD = process.env.RECORD_DIR;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NATIVE_WS_URL = 'wss://test-node-v3.portaldot.dev';
const internal = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../internal/${name}`, import.meta.url)), 'utf8'));
const keys = internal('live-keys.json');
const deployment = internal('live-deployment.json');
mkdirSync(SHOTS, { recursive: true });
if (RECORD) mkdirSync(RECORD, { recursive: true });

const chain = defineChain({
  id: deployment.chainId,
  name: 'Portaldot V3 Testnet',
  nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 },
  rpcUrls: { default: { http: ['https://test-evm-rpc-v3.portaldot.dev'] } },
});
const account = privateKeyToAccount(keys.evm.privateKey);
const transport = http(chain.rpcUrls.default.http[0], { timeout: 60_000 });
const wallet = createWalletClient({ account, chain, transport });
const reader = createPublicClient({ chain, transport });

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(NATIVE_WS_URL), noInitWarn: true });
const nativePair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(keys.native.mnemonic);

const approveZero = encodeFunctionData({
  abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
  functionName: 'approve',
  args: [deployment.executor, 0n],
});

/** When armed, the next executor call is preceded by an out-of-band allowance reset, so it reverts on-chain. */
let revokeBeforeNextExecute = false;
/** A call that will revert can't be estimated, so it reuses 1.5x the last successful executor estimate. */
let executeGas;

async function evmRequest(method, paramsJson) {
  const params = paramsJson ? JSON.parse(paramsJson) : [];
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [account.address];
    case 'eth_chainId':
      return `0x${chain.id.toString(16)}`;
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null;
    case 'personal_sign':
      return account.signMessage({ message: { raw: params[0] } });
    case 'eth_sendTransaction': {
      const [tx] = params;
      const toExecutor = tx.to.toLowerCase() === deployment.executor.toLowerCase();
      if (toExecutor && revokeBeforeNextExecute) {
        revokeBeforeNextExecute = false;
        await reader.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: deployment.token, data: approveZero }), timeout: 180_000 });
        return wallet.sendTransaction({ to: tx.to, data: tx.data, gas: executeGas });
      }
      if (toExecutor) executeGas = ((await reader.estimateGas({ account, to: tx.to, data: tx.data })) * 3n) / 2n;
      return wallet.sendTransaction({ to: tx.to, data: tx.data });
    }
    default:
      return reader.request({ method, params });
  }
}

async function nativeRequest(kind, json) {
  const request = JSON.parse(json);
  if (request.address !== nativePair.address) throw new Error(`unknown native account ${request.address}`);
  if (kind === 'raw') return { id: 1, signature: u8aToHex(nativePair.sign(u8aWrapBytes(hexToU8a(request.data)))) };
  const payload = api.registry.createType('ExtrinsicPayload', request, { version: request.version });
  return { id: 1, signature: payload.sign(nativePair).signature };
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [RECORD ? '--window-size=1920,1080' : '--window-size=1440,900'] });
const page = await browser.newPage();
await page.setViewport(RECORD ? { width: 1920, height: 1080, deviceScaleFactor: 1 } : { width: 1440, height: 900, deviceScaleFactor: 2 });
if (RECORD) {
  await page.evaluateOnNewDocument(() => {
    const mount = () => {
      if (document.getElementById('__cursor')) return;
      const cursor = document.createElement('div');
      cursor.id = '__cursor';
      cursor.innerHTML =
        '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7.2 1.6L9 20z" fill="#0D0E10" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      Object.assign(cursor.style, {
        position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
        transform: `translate(${window.__cursorX ?? 1200}px, ${window.__cursorY ?? 700}px)`,
        transition: 'transform 650ms cubic-bezier(0.22, 1, 0.36, 1)',
      });
      document.body.appendChild(cursor);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  });
}
await page.exposeFunction('__evmWallet', evmRequest);
await page.exposeFunction('__nativeWallet', nativeRequest);
await page.evaluateOnNewDocument((address) => {
  window.ethereum = {
    isHarness: true,
    request: ({ method, params }) => window.__evmWallet(method, params ? JSON.stringify(params) : ''),
    on: () => undefined,
    removeListener: () => undefined,
  };
  const accounts = [{ address, name: 'Treasury payout', type: 'sr25519' }];
  window.injectedWeb3 = {
    'polkadot-js': {
      version: 'harness',
      enable: async () => ({
        accounts: { get: async () => accounts, subscribe: (cb) => (cb(accounts), () => undefined) },
        signer: {
          signRaw: (raw) => window.__nativeWallet('raw', JSON.stringify(raw)),
          signPayload: (payload) => window.__nativeWallet('payload', JSON.stringify(payload)),
        },
      }),
    },
  };
}, nativePair.address);
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

let shot = 0;
async function capture(name) {
  shot += 1;
  const file = join(SHOTS, `${String(shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  await page.screenshot({ path: file.replace(/\.png$/, '-full.png'), fullPage: true });
  console.log(`screenshot ${file}`);
}

async function clickText(text, selector = 'button') {
  await page.waitForFunction(
    (sel, label) => [...document.querySelectorAll(sel)].some((node) => node.textContent?.includes(label) && !node.disabled),
    { timeout: 60_000 },
    selector,
    text,
  );
  if (RECORD) {
    await page.evaluate(
      (sel, label) => [...document.querySelectorAll(sel)].find((item) => item.textContent?.includes(label) && !item.disabled).scrollIntoView({ block: 'center', behavior: 'smooth' }),
      selector,
      text,
    );
    await pause(500);
    const box = await page.evaluate(
      (sel, label) => {
        const rect = [...document.querySelectorAll(sel)].find((item) => item.textContent?.includes(label) && !item.disabled).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      },
      selector,
      text,
    );
    await moveCursor(box.x, box.y);
  }
  await page.evaluate(
    (sel, label) => [...document.querySelectorAll(sel)].find((item) => item.textContent?.includes(label) && !item.disabled).click(),
    selector,
    text,
  );
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function moveCursor(x, y) {
  await page.evaluate(
    (px, py) => {
      window.__cursorX = px;
      window.__cursorY = py;
      const cursor = document.getElementById('__cursor');
      if (cursor) cursor.style.transform = `translate(${px - 4}px, ${py - 2}px)`;
    },
    x,
    y,
  );
  await pause(800);
}

let recording = null;
async function scene(name, holdMs = 1500) {
  if (!RECORD) return;
  if (recording) {
    await pause(holdMs);
    await recording.stop();
  }
  recording = name ? await page.screencast({ path: join(RECORD, `${name}.webm`) }) : null;
  if (name) await pause(600);
}

async function typeInto(selector, text) {
  if (RECORD) {
    const box = await (await page.$(selector)).boundingBox();
    await moveCursor(box.x + 40, box.y + box.height / 2);
  }
  await page.type(selector, text, { delay: RECORD ? 45 : 0 });
}

async function clickLabel(label) {
  await page.waitForSelector(`[aria-label="${label}"]`, { timeout: 60_000 });
  await page.click(`[aria-label="${label}"]`);
}

async function waitForText(text, timeout = 90_000) {
  await page.waitForFunction((label) => document.body.innerText.includes(label), { timeout }, text);
}

/** Finality on V3 takes a few blocks; keep asking the chain until the page shows every expected status. */
async function checkUntil(predicate, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await clickText('Check the chain now');
    try {
      await page.waitForFunction(predicate, { timeout: 15_000 });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}

const step = (message) => console.log(`- ${message}`);
const stamp = Date.now().toString(36);

try {
  step('sign in with the EVM wallet');
  await page.goto(`${WEB_URL}/app`, { waitUntil: 'networkidle2' });
  await waitForText('Sign in with EVM wallet');
  await capture('sign-in');
  await clickText('Sign in with EVM wallet');
  await page.waitForFunction(() => /Create the organisation|Payout runs/.test(document.body.innerText), { timeout: 60_000 });
  if (await page.evaluate(() => document.body.innerText.includes('Create the organisation'))) {
    await page.type('input[placeholder="Northwind Contributors DAO"]', 'Northwind Contributors DAO');
    await clickText('Create organisation');
    await waitForText('Payout runs');
  }

  step('register both payout wallets from their own signatures');
  await page.goto(`${WEB_URL}/app/settings/wallets`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !document.querySelector('.skeleton'), { timeout: 30_000 }).catch(() => undefined);
  const hasButton = (label) => page.evaluate((text) => [...document.querySelectorAll('button')].some((node) => node.textContent?.includes(text)), label);
  if (await hasButton('Register the connected EVM wallet')) {
    await clickText('Register the connected EVM wallet');
    await waitForText('Signature verified');
  }
  if (await hasButton('Choose a native account to register')) {
    await clickText('Choose a native account to register');
    await clickLabel(`Register ${nativePair.address}`);
    await page.waitForFunction((address) => !document.querySelector(`[aria-label="Register ${address}"]`), { timeout: 60_000 }, nativePair.address);
  }
  await capture('wallets');

  step('import, validate and freeze');
  const csv = [
    'line_id,environment,asset_id,destination,amount,reference,recipient_name',
    `NOV-01,native,tPOT,${keys.recipients.native[0].address},0.5,Design retainer,Ada Okafor`,
    `NOV-02,evm,${deployment.token},${keys.recipients.evm[0]},12.5,Audit review,Ben Marsh`,
    `NOV-03,evm,${deployment.token},${keys.recipients.evm[1]},30,Docs sprint,Chen Liu`,
  ].join('\n');
  const csvPath = join(SHOTS, 'november-payouts.csv');
  writeFileSync(csvPath, csv);
  await page.goto(`${WEB_URL}/app/runs/new`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[placeholder="November contributor payouts"]');
  await scene('import');
  await typeInto('input[placeholder="November contributor payouts"]', RECORD ? 'November contributor payouts' : `November contributor payouts ${stamp}`);
  await (await page.$('input[type=file]')).uploadFile(csvPath);
  await waitForText('Loaded november-payouts.csv');
  await clickText('Validate sheet');
  await waitForText('3 lines ready to freeze');
  await capture('import');
  await scene('freeze');
  await clickText('Freeze version for review');
  await waitForText('waiting for approval');
  await capture('review');

  step('approve the exact digest');
  await pause(RECORD ? 2500 : 0);
  await clickText('Approve version 1');
  await waitForText('Execute approved payments');
  await scene('sign');

  step('pay the native line and the first EVM line');
  await clickText('Build payment plan');
  await waitForText('Safe to pay (3)');
  await capture('execute-plan');
  await clickText('Sign payment for NOV-01');
  await waitForText('counts as paid only after finality', 120_000);
  await clickText('Sign payment for NOV-02');
  await page.waitForFunction(() => document.body.innerText.split('counts as paid only after finality').length - 1 >= 2, { timeout: 180_000 });

  step('pay NOV-03 with its allowance revoked out of band, so it reverts on-chain');
  revokeBeforeNextExecute = true;
  await clickText('Sign payment for NOV-03');
  await page.waitForFunction(() => document.body.innerText.split('counts as paid only after finality').length - 1 >= 3, { timeout: 240_000 });
  await capture('execute-sent');

  step('wait for finality and read the chain');
  const runPath = new URL(page.url()).pathname.replace(/\/execute$/, '');
  await page.goto(`${WEB_URL}${runPath}/live`, { waitUntil: 'networkidle2' });
  await capture('live-pending');
  await scene(null);
  await checkUntil(() => document.body.innerText.includes('Failed, verified') && document.body.innerText.split('Paid, verified').length - 1 >= 2);
  await page.reload({ waitUntil: 'networkidle2' });
  await scene('settle');
  await clickText('Show proof');
  await pause(RECORD ? 3000 : 0);
  await capture('settlement');

  step('recover only NOV-03');
  await page.goto(`${WEB_URL}${runPath}/recover`, { waitUntil: 'networkidle2' });
  await scene('recover');
  await clickText('Build recovery plan');
  await waitForText('Safe to pay (1)');
  await capture('recover-plan');
  await clickText('Sign payment for NOV-03');
  await waitForText('counts as paid only after finality', 180_000);
  await scene(null);
  await page.goto(`${WEB_URL}${runPath}/live`, { waitUntil: 'networkidle2' });
  await checkUntil(() => !document.body.innerText.includes('Failed, verified') && document.body.innerText.split('Paid, verified').length - 1 >= 3);
  await page.reload({ waitUntil: 'networkidle2' });
  await scene('settled');
  await pause(RECORD ? 2500 : 0);
  await capture('settlement-after-recovery');

  step('export');
  await page.goto(`${WEB_URL}${runPath}/export`, { waitUntil: 'networkidle2' });
  await waitForText('Every line is verified on-chain');
  await scene('export');
  if (RECORD) await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
  await pause(RECORD ? 2500 : 0);
  await capture('export');
  const exported = await page.evaluate(async (path) => (await fetch(`/api/v1${path.replace('/app', '')}/export.csv`)).text(), runPath);
  const rows = exported.trim().split('\r\n');
  if (rows.length !== 4 || rows.slice(1).some((row) => !row.includes(',paid_verified,'))) throw new Error(`unexpected export:\n${exported}`);
  writeFileSync(join(SHOTS, 'export.csv'), exported);

  step('dashboard');
  await page.goto(`${WEB_URL}/app`, { waitUntil: 'networkidle2' });
  await waitForText('Lines verified paid');
  await scene('dashboard');
  await capture('dashboard');
  await scene(null, 2500);

  if (pageErrors.length) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`production browser flow passed: ${WEB_URL}${runPath}`);
} catch (error) {
  await capture('failure');
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await api.disconnect();
}
