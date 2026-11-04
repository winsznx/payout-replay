import { EvmAdapter } from '@payout-replay/adapters-evm';
import { NativeAdapter } from '@payout-replay/adapters-native';
import type { AssetDescriptor, CapabilityStatus, Environment, NetworkIdentity } from '@payout-replay/core';

import type { Config } from '../config.js';

export interface EnvironmentHealth {
  environment: Environment;
  configured: boolean;
  capability: CapabilityStatus;
  rpcAvailable: boolean;
  provider: string | null;
  identity: Record<string, unknown> | null;
  finalizedBlock: string | null;
  bestBlock: string | null;
  feeAsset: string | null;
  detail: string;
  checkedAt: string;
}

export interface ChainHealth {
  native: EnvironmentHealth;
  evm: EnvironmentHealth;
  assets: (AssetDescriptor & { codeHash?: string })[];
}

const HEALTH_TTL_MS = 30_000;

/**
 * Owns the chain adapters and the verified view of each network. Capability
 * starts `unverified` and only becomes `verified` after live checks pass, so
 * actions on an unchecked or broken network stay disabled.
 */
export class ChainRegistry {
  readonly native: NativeAdapter | null;
  readonly evm: EvmAdapter | null;
  private cached: { at: number; health: ChainHealth } | null = null;
  private inflight: Promise<ChainHealth> | null = null;
  private knownSs58 = 42;

  constructor(private readonly config: Config) {
    this.native = config.NATIVE_WS_URL
      ? new NativeAdapter({
          wsUrl: config.NATIVE_WS_URL,
          providerLabel: config.NATIVE_PROVIDER_LABEL,
          ...(config.NATIVE_GENESIS_HASH ? { expectedGenesisHash: config.NATIVE_GENESIS_HASH } : {}),
        })
      : null;
    this.evm =
      config.EVM_RPC_URL && config.EVM_CHAIN_ID && config.EVM_EXECUTOR_ADDRESS
        ? new EvmAdapter({
            rpcUrl: config.EVM_RPC_URL,
            chainId: config.EVM_CHAIN_ID,
            executorAddress: config.EVM_EXECUTOR_ADDRESS,
            executorDeployBlock: config.EVM_EXECUTOR_DEPLOY_BLOCK,
            providerLabel: config.EVM_PROVIDER_LABEL,
          })
        : null;
  }

  ss58Prefix(): number {
    return this.knownSs58;
  }

  networkLabel(environment: Environment): string {
    if (environment === 'evm') return this.config.EVM_CHAIN_ID ? `eip155:${this.config.EVM_CHAIN_ID}` : 'evm:unconfigured';
    return this.config.NATIVE_GENESIS_HASH ? `substrate:${this.config.NATIVE_GENESIS_HASH}` : 'substrate:unconfigured';
  }

  explorerTxUrl(environment: Environment, txHash: string): string | null {
    const template = environment === 'evm' ? this.config.EVM_EXPLORER_TX_URL : this.config.NATIVE_EXPLORER_TX_URL;
    return template ? template.replace('{tx}', txHash) : null;
  }

  async health(options: { fresh?: boolean } = {}): Promise<ChainHealth> {
    if (!options.fresh && this.cached && Date.now() - this.cached.at < HEALTH_TTL_MS) return this.cached.health;
    this.inflight ??= this.probe().finally(() => {
      this.inflight = null;
    });
    const health = await this.inflight;
    this.cached = { at: Date.now(), health };
    return health;
  }

  private async probe(): Promise<ChainHealth> {
    const [native, evm] = await Promise.all([this.probeNative(), this.probeEvm()]);
    return { native: native.health, evm: evm.health, assets: [...native.assets, ...evm.assets] };
  }

  private base(environment: Environment, provider: string | null): EnvironmentHealth {
    return {
      environment,
      configured: provider !== null,
      capability: provider === null ? 'unavailable' : 'unverified',
      rpcAvailable: false,
      provider,
      identity: null,
      finalizedBlock: null,
      bestBlock: null,
      feeAsset: null,
      detail: provider === null ? 'not configured' : 'not checked yet',
      checkedAt: new Date().toISOString(),
    };
  }

  private async probeNative(): Promise<{ health: EnvironmentHealth; assets: AssetDescriptor[] }> {
    const health = this.base('native', this.native?.provider ?? null);
    if (!this.native) return { health, assets: [] };
    try {
      const identity = await this.native.getNetworkIdentity();
      this.knownSs58 = identity.ss58Prefix;
      const [finality, asset] = await Promise.all([this.native.getFinality(), this.native.validateAsset(identity.tokenSymbol)]);
      return {
        health: {
          ...health,
          rpcAvailable: true,
          capability: asset.capability,
          identity: { ...identity },
          finalizedBlock: finality.finalizedBlockNumber,
          bestBlock: finality.bestBlockNumber,
          feeAsset: identity.tokenSymbol,
          detail: asset.label ?? '',
        },
        assets: [asset],
      };
    } catch (error) {
      return { health: { ...health, detail: `native RPC unavailable: ${(error as Error).message}` }, assets: [] };
    }
  }

  private async probeEvm(): Promise<{ health: EnvironmentHealth; assets: (AssetDescriptor & { codeHash?: string })[] }> {
    const health = this.base('evm', this.evm?.provider ?? null);
    if (!this.evm) return { health, assets: [] };
    try {
      const identity = await this.evm.getNetworkIdentity();
      const [finality, codeHash] = await Promise.all([this.evm.getFinality(), this.evm.getExecutorCodeHash()]);
      const assets = await Promise.all(
        this.config.EVM_TOKENS.map(async (token) => {
          try {
            return await this.evm!.validateAsset(token);
          } catch (error) {
            return {
              environment: 'evm' as const,
              assetId: token,
              symbol: '?',
              decimals: 0,
              allowlisted: false,
              capability: 'unavailable' as const,
              label: `token check failed: ${(error as Error).message.split('\n')[0]}`,
            };
          }
        }),
      );
      return {
        health: {
          ...health,
          rpcAvailable: true,
          capability: 'verified',
          identity: { ...identity, executorCodeHash: codeHash },
          finalizedBlock: finality.finalizedBlockNumber,
          bestBlock: finality.bestBlockNumber,
          feeAsset: 'tPOT (18-decimal EVM view)',
          detail: `PayoutExecutor deployed at ${identity.executorAddress}`,
        },
        assets,
      };
    } catch (error) {
      return { health: { ...health, detail: `EVM RPC unavailable: ${(error as Error).message.split('\n')[0]}` }, assets: [] };
    }
  }

  /** Live network identity for freezing; refuses to guess when a used environment is unreachable. */
  async networkIdentity(environments: ReadonlySet<Environment>): Promise<NetworkIdentity> {
    const identity: NetworkIdentity = {};
    if (environments.has('native')) {
      if (!this.native) throw new Error('native environment is not configured');
      identity.native = await this.native.getNetworkIdentity();
    }
    if (environments.has('evm')) {
      if (!this.evm) throw new Error('EVM environment is not configured');
      identity.evm = await this.evm.getNetworkIdentity();
    }
    return identity;
  }

  adapterFor(environment: Environment): NativeAdapter | EvmAdapter {
    const adapter = environment === 'native' ? this.native : this.evm;
    if (!adapter) throw new Error(`${environment} environment is not configured`);
    return adapter;
  }

  async close(): Promise<void> {
    await this.native?.disconnect();
  }
}
