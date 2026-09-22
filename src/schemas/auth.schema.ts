import { z } from 'zod';

export const DhanCallbackQuerySchema = z.object({
  consentId: z.string().optional(),
  tokenId: z.string().optional(),
  state: z.string().optional(),
});

export const DhanLoginQuerySchema = z.object({
  /** Overrides DHAN_CLIENT_ID for this login. */
  clientId: z.string().optional(),
});

export const DhanTokenLoginSchema = z.object({
  accessToken: z.string().min(20, 'That does not look like a Dhan access token.'),
  dhanClientId: z.string().min(1, 'A Dhan client id is required.'),
});

export const DhanStatusResponseSchema = z.object({
  connected: z.boolean(),
  dhanClientId: z.string().optional(),
  connectedAt: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
  expired: z.boolean().optional(),
  oauthConfigured: z.boolean().optional(),
  methods: z.object({ oauth: z.boolean(), token: z.boolean() }).optional(),
});

export type DhanTokenLogin = z.infer<typeof DhanTokenLoginSchema>;
export type DhanCallbackQuery = z.infer<typeof DhanCallbackQuerySchema>;
export type DhanStatusResponse = z.infer<typeof DhanStatusResponseSchema>;
