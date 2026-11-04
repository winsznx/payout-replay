// LOCAL BROWSER END-TO-END RUN. Drives the real web app in Chrome against the
// real API, Postgres and an anvil chain. The injected wallet is a test harness:
// it forwards EIP-1193 requests to a Node-side viem account holding an anvil
// key. Every chain effect is a real anvil transaction; nothing is simulated.
//
// Usage: WEB_URL=http://localhost:3100 RPC_URL=http://127.0.0.1:8545 \
//        TOKEN=0x... EXECUTOR=0x... node e2e/browser-flow.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import puppeteer from 'puppeteer-core';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3100';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const TOKEN = process.env.TOKEN;
const EXECUTOR = process.env.EXECUTOR;
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'payout-replay-shots');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!TOKEN || !EXECUTOR) throw new Error('TOKEN and EXECUTOR are required');
mkdirSync(SHOTS, { recursive: true });

// A fresh payout wallet per run, so every run starts as a brand-new operator.
const account = privateKeyToAccount(generatePrivateKey());
// anvil account #0 deployed the TEST TOKEN and can mint it.
const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const transport = http(RPC_URL);
const wallet = createWalletClient({ account, chain: foundry, transport });
const minter = createWalletClient({ account: deployer, chain: foundry, transport });
const reader = createPublicClient({ chain: foundry, transport });
const tester = createTestClient({ chain: foundry, mode: 'anvil', transport });
await tester.setBalance({ address: account.address, value: 10n ** 20n });
const mintData = encodeFunctionData({
  abi: [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }],
  functionName: 'mint',
  args: [account.address, 1_000_000_000n],
});
await reader.waitForTransactionReceipt({ hash: await minter.sendTransaction({ to: TOKEN, data: mintData }) });
const RECIPIENTS = ['0x90F79bf6EB2c4f870365E785982E1f101E93b906', '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'];
const approveZero = encodeFunctionData({
  abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
  functionName: 'approve',
  args: [EXECUTOR, 0n],
});

/** When armed, the next executor call is preceded by an out-of-band allowance reset, so it reverts on-chain. */
let revokeBeforeNextExecute = false;

async function walletRequest(method, paramsJson) {
  const params = paramsJson ? JSON.parse(paramsJson) : [];
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [account.address];
    case 'eth_chainId':
      return `0x${foundry.id.toString(16)}`;
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null;
    case 'personal_sign':
      return account.signMessage({ message: { raw: params[0] } });
    case 'eth_sendTransaction': {
      const [tx] = params;
      if (revokeBeforeNextExecute && tx.to.toLowerCase() === EXECUTOR.toLowerCase()) {
        revokeBeforeNextExecute = false;
        const reset = await wallet.sendTransaction({ to: TOKEN, data: approveZero });
        await reader.waitForTransactionReceipt({ hash: reset });
      }
      return wallet.sendTransaction({ to: tx.to, data: tx.data, gas: 400_000n });
    }
    default:
      return reader.request({ method, params });
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1440,1000'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.exposeFunction('__payoutReplayWallet', walletRequest);
await page.evaluateOnNewDocument(() => {
  window.ethereum = {
    isHarness: true,
    request: ({ method, params }) => window.__payoutReplayWallet(method, params ? JSON.stringify(params) : ''),
    on: () => undefined,
    removeListener: () => undefined,
  };
});
const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(error.message));

let shot = 0;
async function capture(name) {
  shot += 1;
  const file = join(SHOTS, `${String(shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`screenshot ${file}`);
}

async function clickText(text, selector = 'button') {
  await page.waitForFunction(
    (sel, label) => [...document.querySelectorAll(sel)].some((node) => node.textContent?.includes(label) && !node.disabled),
    { timeout: 30_000 },
    selector,
    text,
  );
  await page.evaluate(
    (sel, label) => {
      const node = [...document.querySelectorAll(sel)].find((item) => item.textContent?.includes(label) && !item.disabled);
      node.click();
    },
    selector,
    text,
  );
}

async function waitForText(text, timeout = 60_000) {
  await page.waitForFunction((label) => document.body.innerText.includes(label), { timeout }, text);
}

async function finalize() {
  await tester.mine({ blocks: 70 });
}

const step = (message) => console.log(`- ${message}`);

try {
  step('sign in with the EVM wallet');
  await page.goto(`${WEB_URL}/app`, { waitUntil: 'domcontentloaded' });
  await waitForText('Sign in with EVM wallet');
  await capture('sign-in');
  await clickText('Sign in with EVM wallet');
  await waitForText('Create the organisation');
  await page.type('input[placeholder="Northwind Contributors DAO"]', `Harness DAO ${Date.now().toString(36)}`);
  await clickText('Create organisation');
  await waitForText('Payout runs');

  step('register the payout wallet from its own signature');
  await page.goto(`${WEB_URL}/app/settings/wallets`, { waitUntil: 'domcontentloaded' });
  await clickText('Register the connected EVM wallet');
  await waitForText('Signature verified');
  await capture('wallets');

  step('import, validate and freeze');
  const csv = [
    'line_id,environment,asset_id,destination,amount,reference,recipient_name',
    `HB-1,evm,${TOKEN},${RECIPIENTS[0]},12.5,HB-1,Recipient One`,
    `HB-2,evm,${TOKEN},${RECIPIENTS[1]},30,HB-2,Recipient Two`,
  ].join('\n');
  const csvPath = join(SHOTS, 'harness.csv');
  writeFileSync(csvPath, csv);
  await page.goto(`${WEB_URL}/app/runs/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="November contributor payouts"]');
  await page.type('input[placeholder="November contributor payouts"]', 'Harness run');
  const input = await page.$('input[type=file]');
  await input.uploadFile(csvPath);
  await waitForText('Loaded harness.csv');
  await clickText('Validate sheet');
  await waitForText('2 lines ready to freeze');
  await capture('import');
  await clickText('Freeze version for review');
  await waitForText('waiting for approval');
  await capture('review');

  step('approve the exact digest');
  await clickText('Approve version 1');
  await waitForText('Execute approved payments');

  step('pay HB-1 normally');
  await clickText('Build payment plan');
  await waitForText('Safe to pay (2)');
  await capture('execute-plan');
  await clickText('Sign payment for HB-1');
  await waitForText('counts as paid only after finality');

  step('pay HB-2 with its allowance revoked out of band, so it reverts on-chain');
  revokeBeforeNextExecute = true;
  await clickText('Sign payment for HB-2');
  await page.waitForFunction(() => document.body.innerText.split('counts as paid only after finality').length - 1 >= 2, { timeout: 90_000 });
  await capture('execute-sent');

  step('finalize and check the chain');
  await finalize();
  const runPath = new URL(page.url()).pathname.replace(/\/execute$/, '');
  await page.goto(`${WEB_URL}${runPath}/live`, { waitUntil: 'domcontentloaded' });
  await clickText('Check the chain now');
  await waitForText('Failed, verified');
  await waitForText('Paid, verified');
  await clickText('Show proof');
  await capture('settlement');

  step('recover only HB-2');
  await page.goto(`${WEB_URL}${runPath}/recover`, { waitUntil: 'domcontentloaded' });
  await clickText('Build recovery plan');
  await waitForText('Safe to pay (1)');
  await capture('recover-plan');
  await clickText('Sign payment for HB-2');
  await waitForText('counts as paid only after finality', 90_000);
  await finalize();
  await page.goto(`${WEB_URL}${runPath}/live`, { waitUntil: 'domcontentloaded' });
  await clickText('Check the chain now');
  await page.waitForFunction(() => !document.body.innerText.includes('Failed, verified'), { timeout: 60_000 });
  await capture('settlement-after-recovery');

  step('export');
  await page.goto(`${WEB_URL}${runPath}/export`, { waitUntil: 'domcontentloaded' });
  await waitForText('Every line is verified on-chain');
  await capture('export');
  const exported = await page.evaluate(async (path) => (await fetch(`/api/v1${path.replace('/app', '')}/export.csv`)).text(), runPath);
  const rows = exported.trim().split('\r\n');
  if (rows.length !== 3 || rows.slice(1).some((row) => !row.includes(',paid_verified,'))) throw new Error(`unexpected export:\n${exported}`);
  writeFileSync(join(SHOTS, 'export.csv'), exported);

  step('dashboard and mobile layout');
  await page.goto(`${WEB_URL}/app`, { waitUntil: 'domcontentloaded' });
  await waitForText('Lines verified paid');
  await page.waitForFunction(() => !document.body.innerText.includes('—'), { timeout: 20_000 }).catch(() => undefined);
  await capture('dashboard');
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await page.goto(`${WEB_URL}${runPath}/live`, { waitUntil: 'domcontentloaded' });
  await waitForText('Where the money stands');
  await capture('settlement-mobile');
  await page.goto(`${WEB_URL}/`, { waitUntil: 'domcontentloaded' });
  await capture('landing-mobile');

  if (consoleErrors.length) throw new Error(`page errors:\n${consoleErrors.join('\n')}`);
  console.log('browser flow passed');
} catch (error) {
  await capture('failure');
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
