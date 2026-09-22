import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().transform((val) => parseInt(val, 10)).default('3000'),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DHAN_CLIENT_ID: z.string().optional(),
  DHAN_ACCESS_TOKEN: z.string().optional(),
  DHAN_BASE_URL: z.string().default('https://api.dhan.co'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  TOKEN_ENCRYPTION_SECRET: z.string().default('super-secret-key-32-chars-minimum-key!'),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
