import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  /** Origin of the web app; used for challenge binding and CSRF origin checks. */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  /** Domain named in sign-in challenges. */
  APP_DOMAIN: z.string().default('localhost:3000'),

  NATIVE_WS_URL: z.string().url().optional(),
  NATIVE_GENESIS_HASH: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
  NATIVE_PROVIDER_LABEL: z.string().default('portaldot-v3-node'),

  EVM_RPC_URL: z.string().url().optional(),
  EVM_CHAIN_ID: z.coerce.number().int().positive().optional(),
  EVM_EXECUTOR_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  EVM_EXECUTOR_DEPLOY_BLOCK: z.coerce.bigint().default(0n),
  EVM_PROVIDER_LABEL: z.string().default('portaldot-v3-evm-rpc'),
  /** Allowlisted ERC-20 contracts offered as payout assets. */
  EVM_TOKENS: csv,
  /** Explorer URL templates, e.g. https://explorer/tx/{tx}. Left blank when no reliable explorer exists. */
  NATIVE_EXPLORER_TX_URL: z.string().default(''),
  EVM_EXPLORER_TX_URL: z.string().default(''),

  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Minimum gap between reconciliations of one run triggered by "Check now". */
  RECONCILE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(5_000),
  /** How long a prepared attempt may wait for a wallet signature before it is treated as unknown. */
  SIGNATURE_WINDOW_MS: z.coerce.number().int().positive().default(10 * 60_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`invalid configuration:\n${problems}`);
  }
  const config = parsed.data;
  const evmKeys = [config.EVM_RPC_URL, config.EVM_CHAIN_ID, config.EVM_EXECUTOR_ADDRESS];
  if (evmKeys.some(Boolean) && !evmKeys.every(Boolean)) {
    throw new Error('EVM_RPC_URL, EVM_CHAIN_ID and EVM_EXECUTOR_ADDRESS must be set together');
  }
  return config;
}
