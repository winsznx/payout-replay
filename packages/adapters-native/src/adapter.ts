import '@polkadot/api-augment';
import { ApiPromise, WsProvider } from '@polkadot/api';
import type { SignedBlock } from '@polkadot/types/interfaces';
import type {
  AssetDescriptor,
  AttemptLocator,
  AttemptOutcome,
  ChainAdapter,
  ChainEvidence,
  EligibleLine,
  FinalityCheckpoint,
  NativeNetworkIdentity,
  ObservedTransfer,
  PreflightIssue,
  UnsignedTransfer,
} from '@payout-replay/core';
import { sameAddress } from '@payout-replay/core';
import { encodeAddress } from '@polkadot/util-crypto';

/** Mortality the app asks wallets to sign with; bounds how long "not found yet" can last. */
export const DEFAULT_ERA_PERIOD = 64;

export interface NativeAdapterConfig {
  wsUrl: string;
  /** Genesis hash the manifest is frozen to; any other chain is refused. */
  expectedGenesisHash?: string;
  providerLabel?: string;
  api?: ApiPromise;
}

export interface NativeTransferPayload {
  genesisHash: string;
  specVersion: number;
  pallet: 'balances';
  call: 'transferKeepAlive';
  dest: string;
  value: string;
  callHex: string;
  eraPeriod: number;
}

interface Located {
  blockHash: string;
  blockNumber: number;
  index: number;
  block: SignedBlock;
}

export class NativeAdapter implements ChainAdapter<NativeNetworkIdentity, NativeTransferPayload> {
  readonly environment = 'native' as const;
  readonly provider: string;
  private apiPromise: Promise<ApiPromise> | undefined;

  constructor(private readonly config: NativeAdapterConfig) {
    this.provider = config.providerLabel ?? new URL(config.wsUrl).host;
    if (config.api) this.apiPromise = Promise.resolve(config.api);
  }

  api(): Promise<ApiPromise> {
    this.apiPromise ??= ApiPromise.create({
      provider: new WsProvider(this.config.wsUrl, 2_500, {}, 20_000),
      noInitWarn: true,
      throwOnConnect: true,
    }).catch((error: unknown) => {
      this.apiPromise = undefined;
      throw error;
    });
    return this.apiPromise;
  }

  async disconnect(): Promise<void> {
    if (!this.apiPromise) return;
    const api = await this.apiPromise.catch(() => undefined);
    this.apiPromise = undefined;
    await api?.disconnect();
  }

  async getNetworkIdentity(): Promise<NativeNetworkIdentity> {
    const api = await this.api();
    const genesisHash = api.genesisHash.toHex();
    if (this.config.expectedGenesisHash && genesisHash !== this.config.expectedGenesisHash.toLowerCase()) {
      throw new Error(`connected to genesis ${genesisHash}, expected ${this.config.expectedGenesisHash}`);
    }
    return {
      genesisHash,
      specName: api.runtimeVersion.specName.toString(),
      specVersion: api.runtimeVersion.specVersion.toNumber(),
      ss58Prefix: api.registry.chainSS58 ?? 42,
      tokenSymbol: api.registry.chainTokens[0] ?? 'UNIT',
      tokenDecimals: api.registry.chainDecimals[0] ?? 12,
    };
  }

  /** Whether the live runtime metadata exposes the transfer call the app relies on. */
  async transferCallAvailable(): Promise<boolean> {
    const api = await this.api();
    return typeof api.tx.balances?.transferKeepAlive === 'function';
  }

  async validateAsset(assetId: string): Promise<AssetDescriptor> {
    const identity = await this.getNetworkIdentity();
    const callAvailable = await this.transferCallAvailable();
    const matches = assetId.toLowerCase() === identity.tokenSymbol.toLowerCase();
    return {
      environment: 'native',
      assetId: identity.tokenSymbol,
      symbol: identity.tokenSymbol,
      decimals: identity.tokenDecimals,
      allowlisted: matches,
      capability: matches && callAvailable ? 'verified' : 'unavailable',
      label: callAvailable
        ? `native ${identity.tokenSymbol} via Balances.transfer_keep_alive (spec ${identity.specName} v${identity.specVersion})`
        : 'Balances.transfer_keep_alive missing from runtime metadata',
    };
  }

  async getFinality(): Promise<FinalityCheckpoint> {
    const api = await this.api();
    const finalizedHash = await api.rpc.chain.getFinalizedHead();
    const [finalized, best] = await Promise.all([api.rpc.chain.getHeader(finalizedHash), api.rpc.chain.getHeader()]);
    return {
      finalizedBlockNumber: finalized.number.toString(),
      finalizedBlockHash: finalizedHash.toHex(),
      bestBlockNumber: best.number.toString(),
    };
  }

  async getFreeBalance(address: string): Promise<bigint> {
    const api = await this.api();
    const account = await api.query.system.account(address);
    return account.data.free.toBigInt();
  }

  async buildUnsignedTransfer(line: EligibleLine): Promise<UnsignedTransfer<NativeTransferPayload>> {
    if (line.environment !== 'native') throw new Error('native adapter cannot build an EVM transfer');
    const api = await this.api();
    const identity = await this.getNetworkIdentity();
    const amount = BigInt(line.amountBaseUnits);
    const tx = api.tx.balances.transferKeepAlive(line.destination, amount);
    const preflight: PreflightIssue[] = [];

    const [payerAccount, destAccount, info] = await Promise.all([
      api.query.system.account(line.payer),
      api.query.system.account(line.destination),
      tx.paymentInfo(line.payer),
    ]);
    const existentialDeposit = api.consts.balances.existentialDeposit.toBigInt();
    const fee = info.partialFee.toBigInt();
    const free = payerAccount.data.free.toBigInt();

    if (free < amount + fee + existentialDeposit) {
      preflight.push({
        code: 'INSUFFICIENT_NATIVE_BALANCE',
        message: `payer has ${free} base units; needs ${amount} + fee ${fee} and must keep ${existentialDeposit} alive`,
        blocking: true,
      });
    }
    if (destAccount.data.free.toBigInt() === 0n && amount < existentialDeposit) {
      preflight.push({
        code: 'BELOW_EXISTENTIAL_DEPOSIT',
        message: `destination has no balance and ${amount} is below the existential deposit ${existentialDeposit}`,
        blocking: true,
      });
    }

    return {
      environment: 'native',
      obligationId: line.obligationId,
      payer: line.payer,
      method: `Balances.transfer_keep_alive(${line.destination}, ${amount})`,
      payload: {
        genesisHash: identity.genesisHash,
        specVersion: identity.specVersion,
        pallet: 'balances',
        call: 'transferKeepAlive',
        dest: line.destination,
        value: amount.toString(),
        callHex: tx.method.toHex(),
        eraPeriod: DEFAULT_ERA_PERIOD,
      },
      estimatedFee: { amountBaseUnits: fee.toString(), symbol: identity.tokenSymbol, decimals: identity.tokenDecimals },
      preflight,
    };
  }

  private async findInBlock(blockHash: string, txHash: string): Promise<Located | null> {
    const api = await this.api();
    const block = await api.rpc.chain.getBlock(blockHash);
    const index = block.block.extrinsics.findIndex((extrinsic) => extrinsic.hash.toHex() === txHash.toLowerCase());
    if (index < 0) return null;
    return { blockHash, blockNumber: block.block.header.number.toNumber(), index, block };
  }

  /** Scans canonical blocks in [from, to] for the extrinsic hash. */
  private async scan(txHash: string, from: number, to: number): Promise<Located | null> {
    const api = await this.api();
    for (let number = from; number <= to; number += 1) {
      const hash = await api.rpc.chain.getBlockHash(number);
      const found = await this.findInBlock(hash.toHex(), txHash);
      if (found) return found;
    }
    return null;
  }

  private async isCanonicalAndFinal(located: Located): Promise<boolean> {
    const api = await this.api();
    const finality = await this.getFinality();
    if (located.blockNumber > Number(finality.finalizedBlockNumber)) return false;
    const canonical = await api.rpc.chain.getBlockHash(located.blockNumber);
    return canonical.toHex() === located.blockHash;
  }

  /**
   * Reads the events emitted for exactly this extrinsic index. Transfers from
   * other extrinsics in the same block are never attributed to the attempt.
   */
  private async outcomeFromLocation(located: Located, locator: AttemptLocator): Promise<AttemptOutcome> {
    const api = await this.api();
    const extrinsic = located.block.block.extrinsics[located.index]!;
    const signer = extrinsic.signer.toString();
    if (!extrinsic.isSigned || !sameAddress('native', signer, locator.payer)) {
      return { kind: 'unknown', detail: `extrinsic ${locator.txHash} was not signed by the payout wallet` };
    }
    const at = await api.at(located.blockHash);
    const events = await at.query.system.events();
    const own = events.filter(
      (record) => record.phase.isApplyExtrinsic && record.phase.asApplyExtrinsic.toNumber() === located.index,
    );
    const finalized = await this.isCanonicalAndFinal(located);
    const evidence: ChainEvidence = {
      provider: this.provider,
      txHash: locator.txHash,
      blockHash: located.blockHash,
      blockNumber: String(located.blockNumber),
      extrinsicIndex: located.index,
      finalized,
      observedAt: new Date().toISOString(),
    };
    const ss58 = api.registry.chainSS58 ?? 42;
    const succeeded = own.some((record) => api.events.system.ExtrinsicSuccess.is(record.event));
    const failed = own.find((record) => api.events.system.ExtrinsicFailed.is(record.event));

    if (!finalized) return { kind: 'included', evidence };
    if (failed && api.events.system.ExtrinsicFailed.is(failed.event)) {
      const [dispatchError] = failed.event.data;
      let detail = dispatchError.toString();
      if (dispatchError.isModule) {
        const meta = api.registry.findMetaError(dispatchError.asModule);
        detail = `${meta.section}.${meta.name}`;
      }
      return { kind: 'finalized_failure', evidence, reason: 'native_extrinsic_failed', detail: `ExtrinsicFailed: ${detail}` };
    }
    if (!succeeded) return { kind: 'unknown', detail: 'extrinsic has neither ExtrinsicSuccess nor ExtrinsicFailed' };

    const transfers: ObservedTransfer[] = own.flatMap((record) => {
      if (!api.events.balances.Transfer.is(record.event)) return [];
      const [from, to, amount] = record.event.data;
      return [
        {
          environment: 'native' as const,
          assetId: api.registry.chainTokens[0] ?? 'UNIT',
          from: encodeAddress(from.toU8a(), ss58),
          to: encodeAddress(to.toU8a(), ss58),
          amountBaseUnits: amount.toBigInt().toString(),
        },
      ];
    });
    return { kind: 'finalized_success', evidence, transfers };
  }

  async observeAttempt(locator: AttemptLocator): Promise<AttemptOutcome> {
    try {
      const api = await this.api();
      if (locator.blockHash) {
        const located = await this.findInBlock(locator.blockHash, locator.txHash);
        if (located) return await this.outcomeFromLocation(located, locator);
      }
      if (!locator.mortality) {
        return { kind: 'unknown', detail: 'extrinsic not found in the reported block and its mortality window is unknown' };
      }

      const finality = await this.getFinality();
      const finalizedNumber = Number(finality.finalizedBlockNumber);
      const bestNumber = Number(finality.bestBlockNumber);
      const { birthBlock, period } = locator.mortality;
      const lastValid = birthBlock + period;
      const located = await this.scan(locator.txHash, birthBlock, Math.min(lastValid, bestNumber));
      if (located) return await this.outcomeFromLocation(located, locator);

      if (finalizedNumber >= lastValid) {
        return {
          kind: 'finalized_failure',
          reason: 'native_mortality_expired',
          detail: `extrinsic absent from every block of its mortal era (#${birthBlock}-#${lastValid}) and can no longer be included`,
        };
      }
      if (locator.nonce !== undefined) {
        const finalizedApi = await api.at(finality.finalizedBlockHash);
        const account = await finalizedApi.query.system.account(locator.payer);
        if (account.nonce.toNumber() > locator.nonce) {
          return {
            kind: 'finalized_failure',
            reason: 'native_nonce_consumed_elsewhere',
            detail: `nonce ${locator.nonce} was used by a different finalized extrinsic; this one can no longer be included`,
          };
        }
      }
      return { kind: 'pending', detail: `not in any block yet; valid until #${lastValid}` };
    } catch (error) {
      return { kind: 'unknown', detail: `native RPC error: ${(error as Error).message}` };
    }
  }
}
