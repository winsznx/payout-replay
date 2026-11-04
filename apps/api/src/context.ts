import type { ChainRegistry } from './chain/registry.js';
import type { Config } from './config.js';
import type { Database } from './db/client.js';

export type Role = 'owner' | 'operator' | 'reviewer' | 'viewer';

export type ApiScope = 'runs:read' | 'runs:write';

export type Principal =
  | {
      kind: 'user';
      userId: string;
      sessionId: string;
      identity: { id: string; environment: 'native' | 'evm'; address: string };
    }
  | { kind: 'api_key'; keyId: string; orgId: string; scopes: ApiScope[] };

export interface Services {
  db: Database;
  config: Config;
  chains: ChainRegistry;
}

export interface AppEnv {
  Variables: {
    services: Services;
    traceId: string;
    principal?: Principal;
  };
}
