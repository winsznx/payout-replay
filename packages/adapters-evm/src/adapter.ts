import type {
  AssetDescriptor,
  AttemptLocator,
  AttemptOutcome,
  ChainAdapter,
  ChainEvidence,
  EligibleLine,
  EvmNetworkIdentity,
  FinalityCheckpoint,
  Obligation,
  ObservedTransfer,
  PreflightIssue,
  UnsignedTransfer,
} from '@payout-replay/core';
import { digestToBytes32 } from '@payout-replay/core';
import {
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
} from 'viem';

import { erc20Abi, payoutExecutorAbi } from './abi.js';

const PAYMENT_EXECUTED_EVENT = getAbiItem({ abi: payoutExecutorAbi, name: 'PaymentExecuted' });

export interface EvmAdapterConfig {
  rpcUrl: string;
  chainId: number;
  executorAddress: string;
  /** First block to scan for executor events; avoids scanning from genesis. */
  executorDeployBlock?: bigint;
  /** Label recorded on every observation, e.g. "portaldot-v3-evm-rpc". */
  providerLabel?: string;
  gasSymbol?: string;
  gasDecimals?: number;
  client?: PublicClient;
}

export interface EvmCall {
  to: Address;
  data: Hex;
}

export interface EvmTransferPayload {
  chainId: number;
  executor: Address;
  token: Address;
  amount: string;
  currentAllowance: string;
  /** Exact-amount approval, present only when the current allowance is short. */
  approve: EvmCall | null;
  execute: EvmCall;
}

export class EvmAdapter implements ChainAdapter<EvmNetworkIdentity, EvmTransferPayload> {
  readonly environment = 'evm' as const;
  readonly provider: string;
  private readonly client: PublicClient;
  private readonly executor: Address;

  constructor(private readonly config: EvmAdapterConfig) {
    this.provider = config.providerLabel ?? new URL(config.rpcUrl).host;
    this.executor = getAddress(config.executorAddress);
    this.client = config.client ?? createPublicClient({ transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  }

  async getNetworkIdentity(): Promise<EvmNetworkIdentity> {
    const chainId = await this.client.getChainId();
    if (chainId !== this.config.chainId) {
      throw new Error(`RPC reports chain ${chainId}, configured chain is ${this.config.chainId}`);
    }
    const code = await this.client.getCode({ address: this.executor });
    if (!code || code === '0x') throw new Error(`no PayoutExecutor code at ${this.executor}`);
    return { chainId, executorAddress: this.executor };
  }

  async getExecutorCodeHash(): Promise<Hex> {
    const code = await this.client.getCode({ address: this.executor });
    if (!code || code === '0x') throw new Error(`no PayoutExecutor code at ${this.executor}`);
    return keccak256(code);
  }

  async validateAsset(assetId: string): Promise<AssetDescriptor> {
    const token = getAddress(assetId);
    const [code, decimals, symbol, allowlisted] = await Promise.all([
      this.client.getCode({ address: token }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      this.client.readContract({ address: this.executor, abi: payoutExecutorAbi, functionName: 'isAllowlisted', args: [token] }),
    ]);
    const hasCode = Boolean(code && code !== '0x');
    return {
      environment: 'evm',
      assetId: token,
      symbol,
      decimals,
      allowlisted,
      capability: hasCode && allowlisted ? 'verified' : 'unavailable',
      label: hasCode ? `ERC-20 ${symbol} at ${token}` : 'no contract code',
    };
  }

  async getFinality(): Promise<FinalityCheckpoint> {
    const [finalized, best] = await Promise.all([
      this.client.getBlock({ blockTag: 'finalized' }),
      this.client.getBlockNumber({ cacheTime: 0 }),
    ]);
    return {
      finalizedBlockNumber: finalized.number.toString(),
      finalizedBlockHash: finalized.hash,
      bestBlockNumber: best.toString(),
    };
  }

  async getGasBalance(address: string): Promise<bigint> {
    return this.client.getBalance({ address: getAddress(address) });
  }

  async wasExecuted(payer: string, obligationId: string, blockNumber?: bigint): Promise<boolean> {
    return this.client.readContract({
      address: this.executor,
      abi: payoutExecutorAbi,
      functionName: 'wasExecuted',
      args: [getAddress(payer), obligationId as Hex],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
  }

  async buildUnsignedTransfer(
    line: EligibleLine,
    context: { manifestDigest: string },
  ): Promise<UnsignedTransfer<EvmTransferPayload>> {
    if (line.environment !== 'evm') throw new Error('EVM adapter cannot build a native transfer');
    const payer = getAddress(line.payer);
    const token = getAddress(line.assetId);
    const recipient = getAddress(line.destination);
    const amount = BigInt(line.amountBaseUnits);
    const preflight: PreflightIssue[] = [];

    const [chainId, allowlisted, executed, balance, allowance, gasBalance] = await Promise.all([
      this.client.getChainId(),
      this.client.readContract({ address: this.executor, abi: payoutExecutorAbi, functionName: 'isAllowlisted', args: [token] }),
      this.wasExecuted(payer, line.obligationId),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [payer] }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [payer, this.executor] }),
      this.client.getBalance({ address: payer }),
    ]);

    if (chainId !== this.config.chainId) {
      preflight.push({ code: 'WRONG_CHAIN', message: `RPC is on chain ${chainId}, manifest is frozen to ${this.config.chainId}`, blocking: true });
    }
    if (!allowlisted) preflight.push({ code: 'TOKEN_NOT_ALLOWLISTED', message: `${token} is not allowlisted on the executor`, blocking: true });
    if (executed) {
      preflight.push({ code: 'ALREADY_EXECUTED', message: 'the executor already recorded this obligation for this payer', blocking: true });
    }
    if (balance < amount) {
      preflight.push({ code: 'INSUFFICIENT_TOKEN_BALANCE', message: `payer holds ${balance} base units, needs ${amount}`, blocking: true });
    }
    if (gasBalance === 0n) preflight.push({ code: 'NO_GAS', message: 'payer has no balance to pay network fees', blocking: true });

    const approve: EvmCall | null =
      allowance >= amount
        ? null
        : {
            to: token,
            data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [this.executor, amount] }),
          };
    if (approve) {
      preflight.push({
        code: 'APPROVAL_REQUIRED',
        message: `allowance is ${allowance}; the wallet will be asked to approve exactly ${amount} base units first`,
        blocking: false,
      });
    }

    return {
      environment: 'evm',
      obligationId: line.obligationId,
      payer,
      method: `PayoutExecutor.executePayment(${line.obligationId.slice(0, 10)}…, ${token}, ${recipient}, ${amount})`,
      payload: {
        chainId: this.config.chainId,
        executor: this.executor,
        token,
        amount: amount.toString(),
        currentAllowance: allowance.toString(),
        approve,
        execute: {
          to: this.executor,
          data: encodeFunctionData({
            abi: payoutExecutorAbi,
            functionName: 'executePayment',
            args: [
              {
                obligationId: line.obligationId as Hex,
                token,
                recipient,
                amount,
                manifestDigest: digestToBytes32(context.manifestDigest),
              },
            ],
          }),
        },
      },
      preflight,
    };
  }

  /** True when the block is at or below the finalized head and still canonical at that height. */
  private async isFinalized(blockNumber: bigint, blockHash: Hex): Promise<boolean> {
    const finalized = await this.client.getBlock({ blockTag: 'finalized' });
    if (blockNumber > finalized.number) return false;
    const canonical = await this.client.getBlock({ blockNumber });
    return canonical.hash === blockHash;
  }

  private evidence(receipt: TransactionReceipt, finalized: boolean, logIndex?: number): ChainEvidence {
    return {
      provider: this.provider,
      txHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber.toString(),
      ...(logIndex === undefined ? {} : { logIndex }),
      finalized,
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Pairs every PaymentExecuted event from our executor with the ERC-20
   * Transfer it caused. An executor event without its matching Transfer is
   * conflicting evidence and yields `null` so the caller reports `unknown`.
   */
  decodeTransfers(receipt: TransactionReceipt): { transfers: ObservedTransfer[]; firstLogIndex?: number } | null {
    const executorLogs = parseEventLogs({
      abi: payoutExecutorAbi,
      eventName: 'PaymentExecuted',
      logs: receipt.logs.filter((log) => getAddress(log.address) === this.executor),
    });
    const transferLogs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs });
    const transfers: ObservedTransfer[] = [];
    for (const log of executorLogs) {
      const matched = transferLogs.some(
        (transfer) =>
          getAddress(transfer.address) === getAddress(log.args.token) &&
          getAddress(transfer.args.from) === getAddress(log.args.payer) &&
          getAddress(transfer.args.to) === getAddress(log.args.recipient) &&
          transfer.args.value === log.args.amount,
      );
      if (!matched) return null;
      transfers.push({
        environment: 'evm',
        assetId: getAddress(log.args.token),
        from: getAddress(log.args.payer),
        to: getAddress(log.args.recipient),
        amountBaseUnits: log.args.amount.toString(),
        obligationId: log.args.obligationId,
        manifestDigest: `sha256:${log.args.manifestDigest.slice(2)}`,
      });
    }
    const first = executorLogs[0]?.logIndex;
    return first === undefined ? { transfers } : { transfers, firstLogIndex: first };
  }

  private async outcomeFromReceipt(receipt: TransactionReceipt): Promise<AttemptOutcome> {
    const finalized = await this.isFinalized(receipt.blockNumber, receipt.blockHash);
    if (receipt.status === 'reverted') {
      return finalized
        ? { kind: 'finalized_failure', evidence: this.evidence(receipt, true), reason: 'evm_reverted', detail: 'transaction reverted; no tokens moved' }
        : { kind: 'included', evidence: this.evidence(receipt, false) };
    }
    const decoded = this.decodeTransfers(receipt);
    if (!decoded) {
      return { kind: 'unknown', detail: `receipt ${receipt.transactionHash} has an executor event without a matching ERC-20 Transfer` };
    }
    const evidence = this.evidence(receipt, finalized, decoded.firstLogIndex);
    return finalized ? { kind: 'finalized_success', evidence, transfers: decoded.transfers } : { kind: 'included', evidence };
  }

  async observeAttempt(locator: AttemptLocator): Promise<AttemptOutcome> {
    try {
      const hash = locator.txHash as Hex;
      const receipt = await this.client.getTransactionReceipt({ hash }).catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
      if (receipt) {
        if (getAddress(receipt.from) !== getAddress(locator.payer)) {
          return { kind: 'unknown', detail: `transaction ${hash} was sent by ${receipt.from}, not the payout wallet` };
        }
        return await this.outcomeFromReceipt(receipt);
      }

      const pending = await this.client.getTransaction({ hash }).catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) return null;
        throw error;
      });
      if (pending) return { kind: 'pending', detail: 'transaction is known to the node and not yet in a block' };

      if (locator.nonce === undefined) {
        return { kind: 'unknown', detail: 'transaction not found and its nonce was not recorded, so a later inclusion cannot be ruled out' };
      }
      const finalizedNonce = await this.client.getTransactionCount({ address: getAddress(locator.payer), blockTag: 'finalized' });
      if (finalizedNonce <= locator.nonce) {
        return {
          kind: 'unknown',
          detail: `transaction not found and nonce ${locator.nonce} is still unused; the signed transaction could still be broadcast`,
        };
      }
      const finality = await this.getFinality();
      const executed = await this.wasExecuted(locator.payer, locator.obligationId, BigInt(finality.finalizedBlockNumber));
      if (!executed) {
        return {
          kind: 'finalized_failure',
          reason: 'evm_nonce_consumed_without_execution',
          detail: `nonce ${locator.nonce} was consumed by another transaction and the executor has not recorded this obligation at finalized block ${finality.finalizedBlockNumber}`,
        };
      }
      const settlements = await this.scanSettlements({ obligationId: locator.obligationId, payer: locator.payer });
      return settlements.length > 0
        ? { kind: 'finalized_failure', reason: 'evm_replaced', detail: 'this transaction never landed; a replacement settled the obligation' }
        : { kind: 'unknown', detail: 'executor says the obligation executed but its event could not be located' };
    } catch (error) {
      return { kind: 'unknown', detail: `EVM RPC error: ${(error as Error).message.split('\n')[0]}` };
    }
  }

  async scanSettlements(obligation: Pick<Obligation, 'obligationId' | 'payer'>): Promise<AttemptOutcome[]> {
    const logs = await this.client.getLogs({
      address: this.executor,
      event: PAYMENT_EXECUTED_EVENT,
      args: { payer: getAddress(obligation.payer), obligationId: obligation.obligationId as Hex },
      fromBlock: this.config.executorDeployBlock ?? 0n,
      toBlock: 'finalized',
    });
    const hashes = [...new Set(logs.map((log) => log.transactionHash).filter((hash): hash is Hex => hash !== null))];
    const outcomes: AttemptOutcome[] = [];
    for (const hash of hashes) {
      const receipt = await this.client.getTransactionReceipt({ hash });
      outcomes.push(await this.outcomeFromReceipt(receipt));
    }
    return outcomes;
  }
}
