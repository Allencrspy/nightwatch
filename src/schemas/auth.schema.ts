import { z } from 'zod';

export const DhanCallbackQuerySchema = z.object({
  consentId: z.string().optional(),
  tokenId: z.string().optional(),
  state: z.string().optional(),
});

export const DhanStatusResponseSchema = z.object({
  connected: z.boolean(),
  clientId: z.string().optional(),
  connectedAt: z.string().optional(),
  source: z.enum(['ENV', 'OAUTH_CONSENT', 'SANDBOX_MOCK']),
});

export type DhanCallbackQuery = z.infer<typeof DhanCallbackQuerySchema>;
export type DhanStatusResponse = z.infer<typeof DhanStatusResponseSchema>;
