import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const DEV_ONLY_SECRET = 'dev-only-insecure-secret-change-me-32c';

const envSchema = z
  .object({
    PORT: z.string().transform((val) => parseInt(val, 10)).default('3000'),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    /** Where this API is reachable — used to build the OAuth redirect URI. */
    APP_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** Exact origin of the dashboard. Used for CORS and the postMessage target. */
    FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),

    /** Dhan REST base for market data. */
    DHAN_API_BASE: z.string().url().default('https://api.dhan.co/v2'),
    /** Dhan auth host for the partner consent flow. */
    DHAN_AUTH_BASE: z.string().url().default('https://auth.dhan.co'),
    /** App-level registration from Dhan's developer console. NOT a user token. */
    DHAN_PARTNER_ID: z.string().optional(),
    DHAN_PARTNER_SECRET: z.string().optional(),
    /** Symbol -> securityId mapping. */
    DHAN_INSTRUMENT_MASTER_URL: z
      .string()
      .url()
      .default('https://images.dhan.co/api-data/api-scrip-master.csv'),

    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-4o'),

    /** Encrypts Dhan access tokens at rest. Must be set in production. */
    TOKEN_ENCRYPTION_SECRET: z.string().min(32).default(DEV_ONLY_SECRET),
    /** Where encrypted sessions persist, so a restart does not log you out. */
    SESSION_STORE_PATH: z.string().default('.sessions.json'),
  })
  .superRefine((cfg, ctx) => {
    // Fail closed. A known default key is the same as no encryption at all.
    if (cfg.NODE_ENV === 'production' && cfg.TOKEN_ENCRYPTION_SECRET === DEV_ONLY_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TOKEN_ENCRYPTION_SECRET'],
        message:
          'TOKEN_ENCRYPTION_SECRET is still the development default. Set a unique value of at least 32 characters before running in production.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  // Written before the logger exists, and deliberately fatal.
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  process.exit(1);
}

export const env: Env = parsed.data;

/** True when the server holds the app-level credentials the OAuth flow needs. */
export const isDhanOAuthConfigured = Boolean(env.DHAN_PARTNER_ID && env.DHAN_PARTNER_SECRET);
