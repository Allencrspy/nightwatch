import { z } from 'zod';

export const DhanCallbackQuerySchema = z.object({
  consentId: z.string().optional(),
  tokenId: z.string().optional(),
  state: z.string().optional(),
});

export const DhanStatusResponseSchema = z.object({
  connected: z.boolean(),
  dhanClientId: z.string().optional(),
  connectedAt: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
  expired: z.boolean().optional(),
  oauthConfigured: z.boolean().optional(),
});

export type DhanCallbackQuery = z.infer<typeof DhanCallbackQuerySchema>;
export type DhanStatusResponse = z.infer<typeof DhanStatusResponseSchema>;
