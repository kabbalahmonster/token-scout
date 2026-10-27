import { z } from 'zod';

const optionalUrl = z.string().url().optional().or(z.literal(''));
const booleanString = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((value) => value === true || value === 'true');
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(4173),
  DATABASE_PATH: z.string().min(1).default('./data/doomscout.db'),
  AUTH_TOKEN: z.string().default(''),
  PUBLIC_READ: booleanString.default(false),
  // Enable only when the API is reachable exclusively through a trusted
  // reverse proxy. This lets per-client controls use X-Forwarded-For instead
  // of collapsing every proxied visitor into the proxy's loopback address.
  TRUST_PROXY: booleanString.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CHAIN_ID: z.coerce.number().int().positive().default(4663),
  ROBINHOOD_RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),
  ROBINHOOD_BLOCKSCOUT_URL: z.string().url().default('https://robinhoodchain.blockscout.com'),
  DEXSCREENER_API_URL: z.string().url().default('https://api.dexscreener.com'),
  COINGECKO_API_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
  SUSHI_QUOTE_URL: optionalUrl.default('https://api.sushi.com/quote/v7/4663'),
  WRAPPED_NATIVE_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().or(z.literal('')),
  DISCOVERY_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
  WATCHED_POLL_SECONDS: z.coerce.number().int().min(30).max(900).default(60),
  EXPECTED_POLL_SECONDS: z.coerce.number().int().min(30).max(900).default(60),
  ADAPTER_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8000),
  ADAPTER_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  ADAPTER_CACHE_SECONDS: z.coerce.number().int().min(1).default(30),
  PLANNED_BUDGET_WEI: z.string().regex(/^\d+$/).default('100000000000000000'),
  POSITION_COUNT: z.coerce.number().int().min(1).max(100).default(4),
  SWING_THRESHOLDS: z.string().default('0.02,0.05,0.10,0.20').transform((value, context) => {
    const values = value.split(',').map(Number);
    if (values.some((threshold) => !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1)) context.addIssue({ code: 'custom', message: 'Thresholds must be between 0 and 1' });
    return values;
  }),
  SWING_CONFIRMATION_SAMPLES: z.coerce.number().int().min(1).max(20).default(1),
  SWING_MIN_SEPARATION_SECONDS: z.coerce.number().int().min(0).default(60),
  RAW_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  CANDLE_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  HOURLY_RETENTION_DAYS: z.coerce.number().int().min(1).default(730)
});

export type AppConfig = z.output<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    // Values are deliberately omitted: configuration may contain endpoint credentials.
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid DoomScout configuration: ${issues}`);
  }
  if (result.data.NODE_ENV === 'production' && result.data.AUTH_TOKEN.length < 32) {
    throw new Error('AUTH_TOKEN must contain at least 32 characters in production');
  }
  return result.data;
}

export function redactedConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    AUTH_TOKEN: config.AUTH_TOKEN ? '[redacted]' : '',
    ROBINHOOD_RPC_URL: new URL(config.ROBINHOOD_RPC_URL).origin,
    SUSHI_QUOTE_URL: config.SUSHI_QUOTE_URL ? new URL(config.SUSHI_QUOTE_URL).origin : ''
  };
}
