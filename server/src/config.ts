import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().optional().transform((v) => v || undefined),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CONTENT_DIR: z.string().default('../web/public/content'),
  CELO_RPC: z.string().optional().transform((v) => v || undefined),
  CHAIN_ID: z.coerce.number().int().default(42220),
  // Staked rooms. Off unless STAKED=true; needs the rooms proxy, an RPC and the backend (settle) key.
  STAKED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ROOMS_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().or(z.literal('').transform(() => undefined)),
  /** One PlagueRooms contract per stake token: "USDm=0x...,USDT=0x...". ROOMS_ADDRESS alone means a USDm one. */
  STAKE_STACKS: z.string().regex(/^([A-Za-z0-9]{1,8}=0x[0-9a-fA-F]{40})(,[A-Za-z0-9]{1,8}=0x[0-9a-fA-F]{40})*$/).optional().or(z.literal('').transform(() => undefined)),
  BACKEND_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().or(z.literal('').transform(() => undefined)),
  /** Wallets let into the admin page (comma-separated). Holders of a stake contract's admin role are let in as well. */
  ADMIN_ADDRESSES: z.string().default(''),
  STAKED_MIN_ACCOUNT_HOURS: z.coerce.number().min(0).default(24),
  STAKED_MIN_OK_RUNS: z.coerce.number().int().min(0).default(3),
}).refine((c) => !c.STAKED || ((c.ROOMS_ADDRESS || c.STAKE_STACKS) && c.BACKEND_KEY && c.CELO_RPC), { message: 'STAKED=true needs STAKE_STACKS (or ROOMS_ADDRESS), BACKEND_KEY and CELO_RPC' });

export type Config = z.infer<typeof schema> & { origins: string[]; stacks: Array<{ symbol: string; rooms: string }>; admins: string[] };

/** Read and check the environment; the server refuses to start on a bad one rather than guessing. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const c = schema.parse(env);
  const stacks = c.STAKE_STACKS ? c.STAKE_STACKS.split(',').map((x) => { const [symbol, rooms] = x.split('='); return { symbol: symbol!, rooms: rooms! }; })
    : c.ROOMS_ADDRESS ? [{ symbol: 'USDm', rooms: c.ROOMS_ADDRESS }] : [];
  const admins = c.ADMIN_ADDRESSES.split(',').map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  return { ...c, stacks, admins, origins: c.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) };
}
