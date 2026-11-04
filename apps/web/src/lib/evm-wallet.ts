import {
  type Chain,
  type EIP1193Provider,
  type Hex,
  UserRejectedRequestError,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  http,
} from 'viem';

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export const EVM_CHAIN: Chain = defineChain({
  id: Number(process.env.NEXT_PUBLIC_EVM_CHAIN_ID ?? 420420777),
  name: process.env.NEXT_PUBLIC_EVM_CHAIN_NAME ?? 'Portaldot V3 Testnet',
  nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_EVM_RPC_URL ?? 'https://test-evm-rpc-v3.portaldot.dev'] } },
});

function provider(): EIP1193Provider {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('No EVM wallet found. Install MetaMask or another EIP-1193 wallet.');
  }
  return window.ethereum;
}

export function hasEvmWallet(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ethereum);
}

export async function connectEvm(): Promise<`0x${string}`> {
  const [account] = (await provider().request({ method: 'eth_requestAccounts' })) as string[];
  if (!account) throw new Error('The wallet returned no account.');
  return getAddress(account);
}

/** ORG-06: refuse to sign on any chain other than the configured one. */
export async function ensureEvmChain(): Promise<void> {
  const wallet = provider();
  const current = Number(await wallet.request({ method: 'eth_chainId' }));
  if (current === EVM_CHAIN.id) return;
  const chainIdHex = `0x${EVM_CHAIN.id.toString(16)}` as Hex;
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
  } catch {
    await wallet.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: chainIdHex,
          chainName: EVM_CHAIN.name,
          nativeCurrency: EVM_CHAIN.nativeCurrency,
          rpcUrls: [...EVM_CHAIN.rpcUrls.default.http],
        },
      ],
    });
  }
  const after = Number(await wallet.request({ method: 'eth_chainId' }));
  if (after !== EVM_CHAIN.id) throw new Error(`Switch the wallet to chain ${EVM_CHAIN.id} before signing.`);
}

export async function signEvmMessage(address: `0x${string}`, message: string): Promise<Hex> {
  const client = createWalletClient({ account: address, transport: custom(provider()) });
  return client.signMessage({ account: address, message });
}

export type SendResult =
  | { kind: 'rejected' }
  | { kind: 'sent'; txHash: Hex; nonce: number | undefined }
  | { kind: 'unknown'; error: string };

/**
 * Asks the wallet to sign and broadcast one call. A user rejection means
 * nothing was broadcast; any other failure is reported as unknown because
 * the wallet may still have broadcast it.
 */
export async function sendEvmCall(from: `0x${string}`, call: { to: `0x${string}`; data: `0x${string}` }): Promise<SendResult> {
  await ensureEvmChain();
  const client = createWalletClient({ account: from, chain: EVM_CHAIN, transport: custom(provider()) });
  let txHash: Hex;
  try {
    txHash = await client.sendTransaction({ account: from, chain: EVM_CHAIN, to: call.to, data: call.data });
  } catch (error) {
    const rejected =
      error instanceof UserRejectedRequestError ||
      (error as { code?: number }).code === 4001 ||
      (error as { cause?: { code?: number } }).cause?.code === 4001;
    return rejected ? { kind: 'rejected' } : { kind: 'unknown', error: (error as Error).message.split('\n')[0] ?? 'wallet error' };
  }
  let nonce: number | undefined;
  try {
    const reader = createPublicClient({ chain: EVM_CHAIN, transport: custom(provider()) });
    nonce = (await reader.getTransaction({ hash: txHash })).nonce;
  } catch {
    nonce = undefined;
  }
  return { kind: 'sent', txHash, nonce };
}

export async function waitForEvmReceipt(txHash: Hex): Promise<'success' | 'reverted'> {
  const reader = createPublicClient({ chain: EVM_CHAIN, transport: http() });
  const receipt = await reader.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  return receipt.status;
}
